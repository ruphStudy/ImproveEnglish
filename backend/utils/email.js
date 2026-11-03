// Email is optional for free activation and required for web checkout. A
// supplied address is always validated; blanks are never replaced with placeholders.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** { email } (trimmed, or undefined when blank and optional) or { error }. */
function checkEmail(value, { required }) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (value !== undefined && value !== null && typeof value !== 'string') return { error: 'Please enter a valid email address' };
  if (!email) return required ? { error: 'Please enter your email address' } : { email: undefined };
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return { error: 'Please enter a valid email address' };
  return { email };
}

module.exports = { checkEmail };
