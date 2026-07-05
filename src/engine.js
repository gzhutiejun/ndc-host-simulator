const constants = require('./constants');
const { FS, GS, SO, SI } = constants;

function applyTemplate(template, ctx) {
  return template
    .replace(/<FS>/g, FS)
    .replace(/<GS>/g, GS)
    .replace(/<SO>/g, SO)
    .replace(/<SI>/g, SI)
    .replace(/<LUNO>/g, ctx.luno != null ? ctx.luno : '')
    .replace(/<TVN>/g, ctx.tvn != null ? ctx.tvn : '');
}

function matches(match, parsed) {
  if (!match) return true;
  if (match.messageClass != null && parsed.messageClass !== match.messageClass) return false;
  if (match.subClass != null && parsed.subClass !== match.subClass) return false;
  if (match.type != null && parsed.type !== match.type) return false;
  if (match.field != null) {
    const value = parsed.fields[match.field.index];
    if (value == null) return false;
    if (match.field.equals != null && value !== match.field.equals) return false;
    if (match.field.startsWith != null && !value.startsWith(match.field.startsWith)) return false;
  }
  return true;
}

function createEngine({ rules = [], handlers = {} } = {}) {
  return {
    respond(parsed, session) {
      const rule = rules.find((r) => matches(r.match, parsed));
      if (!rule) return { payload: null, rule: null };
      if (rule.noReply === true) return { payload: null, rule: rule.name };
      const ctx = {
        luno: (session && session.luno) || parsed.luno || '',
        tvn: session ? String(session.tvn) : '0',
      };
      if (rule.handler != null) {
        const fn = handlers[rule.handler];
        if (typeof fn !== 'function') {
          throw new Error(`Rule "${rule.name}" references unknown handler "${rule.handler}"`);
        }
        return { payload: fn(parsed, session, { applyTemplate, ctx, constants }), rule: rule.name };
      }
      if (rule.template != null) return { payload: applyTemplate(rule.template, ctx), rule: rule.name };
      throw new Error(`Rule "${rule.name}" matched but defines no template, handler, or noReply`);
    },
  };
}

module.exports = { applyTemplate, matches, createEngine };
