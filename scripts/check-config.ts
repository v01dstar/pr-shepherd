// Validates a config file with the service's own schema (DESIGN §11): npm run check-config [-- path]
import { loadConfig } from '../src/config.js';

const path = process.argv[2] ?? process.env.CONFIG_PATH ?? 'config.yaml';
try {
  const c = loadConfig(path, {});
  console.log(`${path} ok — bot ${c.bot.name}, org ${c.org}, owner @${c.owner.github}, channel #${c.reviewChannel}, ` +
    `reviewers ${c.reviewers.map((r) => r.name).join(', ')}, approvers ${c.approvers.map((a) => a.name).join(', ')}`);
} catch (e) {
  console.error(`${path} is invalid:\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
