import { colour, print } from '../output';
import { versionLine } from '../version';
import { diiiscoHome, logFile } from '../paths';
import { configPath } from '../config';

export function runHelp(): void {
  const b = colour.bold;
  const d = colour.dim;

  print(`${b('diiisco')} — run a DIIISCO node and point agent tools at it

${b('Usage')}
  diiisco <command> [flags]

${b('Commands')}
  setup                  Create or edit the config file (start here)
  start                  Start the node as a background daemon
  stop                   Stop the background daemon
  restart                Restart the daemon
  status [--json]        Show daemon status (pid, uptime, /health, Algorand summary)
  logs [-f] [-n N]       Show (or follow) daemon logs (default 100 lines)
  serve                  Run the node in the foreground (Ctrl-C to stop)
  launch <app> [flags]   Point an agent tool at a DIIISCO node, starting one if needed
  config show|path|edit  Inspect or edit the config file
  version                Print version
  help                   Print this message

${b('setup')}
  diiisco setup                      Interactive wizard; re-run it to edit
  diiisco setup --local --yes        Non-interactive, payment-free node
  diiisco setup --public --yes --network testnet --mnemonic-stdin < wallet.txt
  diiisco setup --print              Emit the JSON to stdout, write nothing

  --local / --public   Mode: payment-free, or joined to the public network
  --yes                Accept defaults, never prompt
  --force              Overwrite a config file that cannot be parsed
  --network NET        mainnet or testnet
  --api-port PORT      HTTP API port
  --models-url URL     Inference backend, e.g. http://localhost:11434
  --max-spend USDC     Ceiling on a single request, public mode only
  --mnemonic-stdin     Read the wallet mnemonic from stdin (never from argv)
  --print              Print the config instead of writing it
  ${d('A mnemonic is only ever read from stdin or an echo-off prompt.')}

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
  diiisco config show [--json]       Effective config, with the mnemonic and API keys redacted
  diiisco config path                Print the config file path
  diiisco config edit                Open it in \$EDITOR and validate before saving

${b('Files')}
  ${configPath()}
  ${logFile()}
  ${d(`Override the location with DIIISCO_CONFIG, or the directory with DIIISCO_HOME (currently ${diiiscoHome()}).`)}

${b('Environment')}
  DIIISCO_HOME       Runtime directory (default ~/.diiisco)
  DIIISCO_CONFIG     Full path to the config file, overriding DIIISCO_HOME
  DIIISCO_ENDPOINT   Default endpoint for \`launch\`
  DIIISCO_API_KEY    Default API key for \`launch\`
  DIIISCO_OWNER      Recorded in daemon.json as who started the node (default "cli")
  NO_COLOR           Disable coloured output

${b('Exit codes')}
  0 success    1 failure    2 no configuration (run \`diiisco setup\`)

${d(versionLine())}`);
}
