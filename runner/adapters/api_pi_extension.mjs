/**
 * Pi extension loaded into the `pi --mode rpc` process of one model API execution (api_pi.mjs starts it). It registers
 * the member's provider and exactly the tools the old in-runner loop offered: room tools bound to this execution,
 * project file tools, registered commands and image tools (api.mjs, api_files.mjs, api_commands.mjs, api_images.mjs).
 * Pi's built-in tools are off, so the model has no shell and every path still goes through our checks.
 *
 * Input: `CODISCUSS_PI_CONTEXT` names the execution's private context file; `CODISCUSS_PI_KEY` holds the API key, which
 * the model never sees. Output to the runner: each tool result's `details.codiscuss` says whether it saved the answer
 * (`terminal`) or hit an uncertain write that must end the run (`fatal`).
 */
import { readFileSync } from 'node:fs';
import { execute_tool, extension_context, participant_tools, wrap_up_note } from './api.mjs';
import { PI_PROVIDER, pi_provider } from './api_pi.mjs';

const NEVER = new AbortController().signal;

/** The model-facing text of one tool result: file tools return text, the rest JSON. */
function result_text(result) {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

export default function codiscuss_room(pi) {
  const setup = JSON.parse(readFileSync(process.env.CODISCUSS_PI_CONTEXT, 'utf8'));
  const key = process.env.CODISCUSS_PI_KEY || '';
  const redact = text => (key ? String(text).replaceAll(key, '[已隐藏]') : String(text));
  const context = extension_context(setup, key);
  pi.registerProvider(PI_PROVIDER, pi_provider(setup.profile, setup.base_url));
  const definitions = participant_tools(context);
  for (const definition of definitions) {
    pi.registerTool({
      name: definition.name, label: definition.name, description: definition.description,
      promptSnippet: `${definition.name}: ${definition.description}`, parameters: definition.parameters,
      // Room writes and file edits keep the order the model gave them, as the in-runner loop ran them.
      executionMode: 'sequential',
      async execute(_id, params, signal, _on_update, ctx) {
        context.signal = signal || NEVER;
        try {
          const outcome = await execute_tool(context, { name: definition.name, arguments: params }, definitions);
          const terminal = Boolean(outcome.terminal);
          return { content: [{ type: 'text', text: redact(result_text(outcome.result)) }], details: { codiscuss: { terminal } },
            isError: Boolean(outcome.result?.error), terminate: terminal };
        } catch (error) {
          if (signal?.aborted) throw error;
          // An uncertain room write is never retried under a new submission: the run ends and the runner reports why.
          const reason = redact(error.message || error);
          ctx.abort();
          return { content: [{ type: 'text', text: reason }], details: { codiscuss: { fatal: reason } }, isError: true, terminate: true };
        }
      },
    });
  }
  // With few requests left, the model is told once per turn to submit what it has, as before.
  let turns = 0;
  let noted = 0;
  pi.on('turn_start', () => { turns += 1; });
  pi.on('tool_result', event => {
    const note = noted === turns ? '' : wrap_up_note(context, turns);
    if (!note) return undefined;
    noted = turns;
    return { content: [...(event.content || []), { type: 'text', text: note }] };
  });
}
