/**
 * Interactive prompts — shared across commands
 */

import { createInterface } from "readline";

export function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Ask for yes/no confirmation.
 * Returns true if user confirms. Skips prompt and returns true if
 * `--yes` flag is set or `--json` mode is active.
 */
export async function confirm(
  message: string,
  opts: { yes?: boolean; json?: boolean } = {},
): Promise<boolean> {
  if (opts.yes || opts.json) return true;
  const answer = await ask(`${message} (y/N): `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}
