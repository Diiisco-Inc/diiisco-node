import { colour, print } from '../output';
import { versionLine } from '../version';
import { configPath, diiiscoHome, logFile } from '../paths';

export function runHelp(): void {
  const b = colour.bold;
  const d = colour.dim;

  print(`${b('diiisco')} — run a DIIISCO node and point agent tools at it

${b('Usage')}
  diiisco <command> [flags]

${b('Commands')}
  start                  Start the node as a background daemon
  stop                   Stop the background daemon
  restart                Restart the daemon
  status [--json]        Show daemon status (pid, uptime, /health, Algorand summary)
  logs [-f] [-n N]       Show (or follow) daemon logs (default 100 lines)
  serve                  Run the node in the foreground (Ctrl-C to stop)
  launch <app> [flags]   Point an agent tool at a DIIISCO node, starting one if needed
  config init|show|path  Manage the config file
  version                Print version
  help                   Print this message

${b('launch')}
  diiisco launch claude              Start (if needed) and open Claude Code against your node
  diiisco launch --list [--json]     List launch targets and whether they are installed

  --endpoint URL   Attach to an existing node (never starts one)
  --remote URL     Alias for --endpoint
  --key KEY        API key to present (default: config, then \$DIIISCO_API_KEY, then "diiisco")
  --model MODEL    Model the app should request
  --no-spawn       Fail instead of starting a local node
  Everything after the app name is passed through to it verbatim.

${b('config')}
  diiisco config init --local        Payment-free node on a private topic
  diiisco config init --public       Join the public network (prompts for a wallet)
  diiisco config show [--json]       Effective config, with the mnemonic and API keys redacted
  diiisco config path                Print the config file path

${b('Files')}
  ${configPath()}
  ${logFile()}
  ${d(`Override the directory with DIIISCO_HOME (currently ${diiiscoHome()}).`)}

${b('Environment')}
  DIIISCO_HOME       Runtime directory (default ~/.diiisco)
  DIIISCO_ENDPOINT   Default endpoint for \`launch\`
  DIIISCO_API_KEY    Default API key for \`launch\`
  DIIISCO_OWNER      Recorded in daemon.json as who started the node (default "cli")
  NO_COLOR           Disable coloured output

${d(versionLine())}`);
}
