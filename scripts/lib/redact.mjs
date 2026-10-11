/**
 * Strip anything that must not land in an artifact or a public CI log: KS tokens, URL query
 * strings (the socket URL carries the partner id as a query parameter), the avatar stream
 * id and session id in a WHEP path, and any UUID.
 * @param {string} text
 */
export function redact(text) {
  return text
    .replace(/djJ8[A-Za-z0-9_=+/-]+/g, '<KS>')
    .replace(/(\/stv\/)[^/\s"'?]+/g, '$1<id>')
    .replace(/(\/whep\/session\/)[^\s"'?]+/g, '$1<id>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/((?:https?|wss?):\/\/[^\s"'?]+)\?[^\s"']*/g, '$1?<query>');
}
