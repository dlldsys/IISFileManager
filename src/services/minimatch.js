function match(str, pattern) {
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp('^' + esc + '$', 'i').test(str);
}

module.exports = match;