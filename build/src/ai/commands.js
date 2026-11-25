'use strict';

/**
 * Chat Bridge - AI command definitions and prompt builder (main process, CommonJS).
 *
 * COMMANDS: the five sidekick commands the UI renders as chips.
 * buildPrompt(command, {contactName, messages, instruction}) -> {system, user} | null
 *   null means "unknown command".
 *
 * Transcript law: messages arrive newest-last from the scraper. The caller is
 * expected to have capped them at config.maxContextMessages already; we still
 * truncate defensively to the last 40 (oldest dropped, newest kept).
 * All user-visible strings: plain language, no em-dashes, no emoji.
 */

const MAX_TRANSCRIPT_MESSAGES = 40;

const SYSTEM_PROMPT =
  'You draft WhatsApp messages for a business operator. ' +
  'Output ONLY the ready-to-paste message text. ' +
  'No preamble like here is your draft, no explanations, no quotation marks around the whole answer, no em-dashes. ' +
  'Match the language of the conversation. Be concise and human.';

const COMMANDS = [
  {
    id: 'draft-reply',
    label: 'Draft reply',
    placeholder: 'Optional tone notes, e.g. keep it short and friendly'
  },
  {
    id: 'summarize',
    label: 'Summarize',
    placeholder: 'Optional focus, e.g. dates and deadlines'
  },
  {
    id: 'reconnect',
    label: 'Reconnect',
    placeholder: 'Optional angle, e.g. mention the new offer'
  },
  {
    id: 'lookup',
    label: 'What we know',
    placeholder: 'Optional focus, e.g. company and role'
  },
  {
    id: 'freeform',
    label: 'Freeform',
    placeholder: 'Any instruction: translate, rewrite, research, draft something else'
  }
];

const KNOWN_COMMANDS = {};
for (let i = 0; i < COMMANDS.length; i++) {
  KNOWN_COMMANDS[COMMANDS[i].id] = true;
}

function capMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.length > MAX_TRANSCRIPT_MESSAGES ? list.slice(-MAX_TRANSCRIPT_MESSAGES) : list;
}

/** Formats the transcript as [them] / [me] lines, newest last. */
function formatTranscript(messages) {
  const list = capMessages(messages);
  const lines = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m.text !== 'string') continue;
    const text = m.text.trim();
    if (!text) continue;
    lines.push((m.fromMe ? '[me] ' : '[them] ') + text);
  }
  if (lines.length === 0) {
    return '(no messages could be read from this chat)';
  }
  return lines.join('\n');
}

function normalizeContactName(contactName) {
  if (typeof contactName === 'string' && contactName.trim()) {
    return contactName.trim();
  }
  return 'this contact';
}

function normalizeInstruction(instruction) {
  return typeof instruction === 'string' ? instruction.trim() : '';
}

function buildPrompt(command, context) {
  if (!KNOWN_COMMANDS[command]) {
    return null;
  }
  const ctx = context && typeof context === 'object' ? context : {};
  const contact = normalizeContactName(ctx.contactName);
  const instruction = normalizeInstruction(ctx.instruction);
  const transcript = formatTranscript(ctx.messages);

  let user;

  if (command === 'draft-reply') {
    user =
      'Chat with: ' + contact + '\n\n' +
      'Transcript of the conversation, newest last:\n' +
      transcript + '\n\n' +
      'Draft ONE reply in the account owner\'s voice continuing this exchange. ' +
      'The operator will review, edit and send it. Output only the reply text.';
    if (instruction) {
      user += '\n\nTone instruction from the operator, follow it: ' + instruction;
    }
    return { system: SYSTEM_PROMPT, user: user };
  }

  if (command === 'summarize') {
    user =
      'Chat with: ' + contact + '\n\n' +
      'Transcript of the conversation, newest last:\n' +
      transcript + '\n\n' +
      'Write a plain summary of this conversation as short bullets. ' +
      'Maximum 10 bullets, each on its own line starting with "- ". ' +
      'Cover the key facts and any open threads. Plain text only, no preamble.';
    if (instruction) {
      user += '\n\nFocus on: ' + instruction;
    }
    return { system: SYSTEM_PROMPT, user: user };
  }

  if (command === 'reconnect') {
    user =
      'Chat with: ' + contact + '\n\n' +
      'Transcript of the conversation, newest last (it may be empty):\n' +
      transcript + '\n\n' +
      'Draft ONE warm, short reconnection message from the account owner to ' + contact + '. ' +
      'Reference something from the transcript if it gives you anything real to reference. ' +
      'If the transcript is empty, write a friendly check-in without pretending to remember specifics. ' +
      'Output only the message text.';
    if (instruction) {
      user += '\n\nTone instruction from the operator, follow it: ' + instruction;
    }
    return { system: SYSTEM_PROMPT, user: user };
  }

  if (command === 'lookup') {
    user =
      'Chat with: ' + contact + '\n\n' +
      'HARD RULE: Answer ONLY from the conversation transcript provided and your general knowledge. ' +
      'Say plainly when something is not known. You have NO live web access. ' +
      'Never invent facts, companies, roles, numbers or dates.\n\n' +
      'Transcript of the conversation, newest last:\n' +
      transcript + '\n\n' +
      'Write a short brief about this contact in exactly two sections, ' +
      'each item as a short bullet line starting with "- ":\n' +
      'Known:\n' +
      '(what the transcript or your general knowledge supports)\n' +
      'Not known:\n' +
      '(what is missing or uncertain, said plainly)';
    if (instruction) {
      user += '\n\nFocus on: ' + instruction;
    }
    return { system: SYSTEM_PROMPT, user: user };
  }

  // freeform
  user =
    'Chat with: ' + contact + '\n\n' +
    'Instruction from the operator:\n' +
    (instruction || '(no instruction given)') + '\n\n' +
    'Transcript of the conversation, newest last, for context:\n' +
    transcript + '\n\n' +
    'Follow the operator\'s instruction. If it asks for a message to the contact, ' +
    'output only that message text.';
  return { system: SYSTEM_PROMPT, user: user };
}

module.exports = {
  COMMANDS: COMMANDS,
  buildPrompt: buildPrompt
};
