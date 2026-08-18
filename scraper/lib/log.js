const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[process.env.SC_LOG_LEVEL] ?? LEVELS.info;

function emit(level, symbol, args) {
  if (LEVELS[level] < threshold) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${symbol} ${args.join(' ')}\n`);
}

export const log = {
  setLevel(level) {
    if (LEVELS[level] !== undefined) threshold = LEVELS[level];
  },
  debug: (...a) => emit('debug', '  ·', a),
  info: (...a) => emit('info', ' ', a),
  step: (...a) => emit('info', '▸', a),
  ok: (...a) => emit('info', '✓', a),
  warn: (...a) => emit('warn', '!', a),
  error: (...a) => emit('error', '✗', a),
  blank: () => { if (threshold <= LEVELS.info) process.stdout.write('\n'); },
};
