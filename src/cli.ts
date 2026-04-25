/**
 * omc-proxy CLI. Runnable via `tsx src/proxy/cli.ts` or built via tsc.
 */

import { Command } from "commander";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  loadConfig,
  redactConfigSecrets,
  defaultConfigPath,
} from "./config.js";
import { startProxy } from "./server.js";
import { auditFilePath } from "./audit.js";
import { atomicWriteJsonSync, safeReadJson } from "./lib/atomic-write.js";
import { TokenStore } from "./auth.js";

interface HitlRecord {
  id: string;
  reqId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  decidedAt?: string;
}

function hitlDir(): string {
  return join(process.cwd(), ".omc", "proxy", "hitl");
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program.name("omc-proxy").description("OMC AI egress proxy");

  program
    .command("start")
    .description("Start the proxy server")
    .option("--config <path>", "Config file path", defaultConfigPath())
    .option("--port <n>", "Override listen port", (v) => parseInt(v, 10))
    .action(async (opts: { config: string; port?: number }) => {
      const cfg = loadConfig(opts.config);
      if (typeof opts.port === "number" && Number.isFinite(opts.port)) {
        cfg.listen.port = opts.port;
      }
      const started = await startProxy({ config: cfg });
      // eslint-disable-next-line no-console
      console.log(
        `[omc-proxy] listening on http://${started.host}:${started.port}`,
      );
      const shutdown = async (): Promise<void> => {
        // eslint-disable-next-line no-console
        console.log("[omc-proxy] shutting down");
        await started.close();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
    });

  program
    .command("audit")
    .argument("<subcommand>", "tail")
    .option("--date <date>", "YYYY-MM-DD")
    .option("--n <n>", "Number of lines", (v) => parseInt(v, 10), 50)
    .option("--config <path>", "Config file", defaultConfigPath())
    .action(
      (
        sub: string,
        opts: { date?: string; n: number; config: string },
      ) => {
        if (sub !== "tail") {
          throw new Error(`Unknown audit subcommand: ${sub}`);
        }
        const cfg = loadConfig(opts.config);
        const date = opts.date ? parseDate(opts.date) : new Date();
        const file = auditFilePath(cfg.audit.dir, date);
        if (!existsSync(file)) {
          // eslint-disable-next-line no-console
          console.log(`[omc-proxy] no audit file: ${file}`);
          return;
        }
        const lines = readFileSync(file, "utf-8")
          .split("\n")
          .filter((l) => l.length > 0);
        const tail = lines.slice(-opts.n);
        // eslint-disable-next-line no-console
        console.log(tail.join("\n"));
      },
    );

  program
    .command("hitl")
    .argument("<subcommand>", "list|approve|deny")
    .argument("[id]")
    .action(async (sub: string, id?: string) => {
      const dir = hitlDir();
      if (sub === "list") {
        if (!existsSync(dir)) {
          // eslint-disable-next-line no-console
          console.log("[omc-proxy] no hitl queue");
          return;
        }
        const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
        for (const f of files) {
          const rec = await safeReadJson<HitlRecord>(join(dir, f));
          if (rec) {
            // eslint-disable-next-line no-console
            console.log(
              `${rec.id}\t${rec.status}\t${rec.toolName}\t${rec.createdAt}`,
            );
          }
        }
        return;
      }
      if (sub === "approve" || sub === "deny") {
        if (!id) throw new Error("id required");
        const file = join(dir, `${id}.json`);
        const rec = await safeReadJson<HitlRecord>(file);
        if (!rec) throw new Error(`HITL record not found: ${id}`);
        rec.status = sub === "approve" ? "approved" : "denied";
        rec.decidedAt = new Date().toISOString();
        atomicWriteJsonSync(file, rec);
        // eslint-disable-next-line no-console
        console.log(`[omc-proxy] ${sub}d ${id}`);
        return;
      }
      throw new Error(`Unknown hitl subcommand: ${sub}`);
    });

  program
    .command("config")
    .argument("<subcommand>", "print")
    .option("--config <path>", "Config file", defaultConfigPath())
    .action((sub: string, opts: { config: string }) => {
      if (sub !== "print") throw new Error(`Unknown config subcommand: ${sub}`);
      const cfg = loadConfig(opts.config);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(redactConfigSecrets(cfg), null, 2));
    });

  function resolveTokensFile(opts: { store?: string; config?: string }): string {
    if (opts.store) return opts.store;
    if (opts.config) {
      const cfg = loadConfig(opts.config);
      if (cfg.auth.tokensFile) return cfg.auth.tokensFile;
    }
    return join(process.cwd(), ".omc", "proxy", "auth.json");
  }

  function parseTtl(input: string | undefined): number | undefined {
    if (!input) return undefined;
    const m = input.match(/^(\d+)([smhd])$/);
    if (!m) throw new Error(`Invalid --ttl: ${input}. Use 30s, 5m, 2h, 90d`);
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
    return n * mult;
  }

  const auth = program.command("auth").description("Manage bearer tokens for the proxy auth lane");

  auth
    .command("issue")
    .description("Issue a new bearer token (plaintext shown ONCE)")
    .requiredOption("--id <id>", "Unique token identifier")
    .option("--scope <scope>", "Scope name", "proxy:request")
    .option("--rpm <n>", "Rate limit (requests/min)", (v) => parseInt(v, 10), 60)
    .option("--per-day <n>", "Daily token cap", (v) => parseInt(v, 10), 100_000)
    .option("--ttl <duration>", "Expiry (e.g. 90d, 12h, 30m)")
    .option("--store <path>", "Tokens file path (overrides config)")
    .option("--config <path>", "Config file", defaultConfigPath())
    .action(
      async (opts: {
        id: string;
        scope: string;
        rpm: number;
        perDay: number;
        ttl?: string;
        store?: string;
        config: string;
      }) => {
        const path = resolveTokensFile(opts);
        const store = new TokenStore(path);
        const { plaintext, record } = await store.issue({
          id: opts.id,
          scopes: [opts.scope],
          rpm: opts.rpm,
          perDay: opts.perDay,
          ttlSeconds: parseTtl(opts.ttl),
        });
        // eslint-disable-next-line no-console
        console.log(`[omc-proxy] token issued: ${record.id}`);
        // eslint-disable-next-line no-console
        console.log(`[omc-proxy] STORE THIS NOW (will not be shown again):`);
        // eslint-disable-next-line no-console
        console.log(plaintext);
      },
    );

  auth
    .command("list")
    .description("List token metadata (plaintext is never stored)")
    .option("--store <path>", "Tokens file path")
    .option("--config <path>", "Config file", defaultConfigPath())
    .action(async (opts: { store?: string; config: string }) => {
      const path = resolveTokensFile(opts);
      const store = new TokenStore(path);
      const tokens = await store.load();
      if (tokens.length === 0) {
        // eslint-disable-next-line no-console
        console.log(`[omc-proxy] no tokens at ${path}`);
        return;
      }
      for (const t of tokens) {
        const expiry = t.expiresAt ?? "never";
        const rotated = t.rotatedFrom ? ` (rotated from ${t.rotatedFrom})` : "";
        // eslint-disable-next-line no-console
        console.log(
          `${t.id}\trpm=${t.rateLimit.rpm}\texpires=${expiry}\tscopes=${t.scopes.join(",")}${rotated}`,
        );
      }
    });

  auth
    .command("revoke")
    .description("Revoke a token by id")
    .argument("<id>")
    .option("--store <path>", "Tokens file path")
    .option("--config <path>", "Config file", defaultConfigPath())
    .action(async (id: string, opts: { store?: string; config: string }) => {
      const path = resolveTokensFile(opts);
      const store = new TokenStore(path);
      const removed = await store.revoke(id);
      // eslint-disable-next-line no-console
      console.log(removed ? `[omc-proxy] revoked ${id}` : `[omc-proxy] no token ${id}`);
      if (!removed) process.exit(1);
    });

  auth
    .command("rotate")
    .description("Issue a replacement token tied to an existing id")
    .argument("<oldId>")
    .argument("<newId>")
    .option("--store <path>", "Tokens file path")
    .option("--config <path>", "Config file", defaultConfigPath())
    .action(
      async (oldId: string, newId: string, opts: { store?: string; config: string }) => {
        const path = resolveTokensFile(opts);
        const store = new TokenStore(path);
        const { plaintext, record } = await store.rotate(oldId, newId);
        // eslint-disable-next-line no-console
        console.log(`[omc-proxy] rotated: ${oldId} → ${record.id}`);
        // eslint-disable-next-line no-console
        console.log(`[omc-proxy] STORE THIS NOW (will not be shown again):`);
        // eslint-disable-next-line no-console
        console.log(plaintext);
        // eslint-disable-next-line no-console
        console.log(`[omc-proxy] reminder: revoke '${oldId}' once clients have switched.`);
      },
    );

  await program.parseAsync(argv);
}

function parseDate(s: string): Date {
  const d = new Date(`${s}T00:00:00Z`);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

// Entry point — only run when executed directly, not when imported.
const isEntry =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli.ts") ||
    process.argv[1].endsWith("cli.js"));
if (isEntry) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
