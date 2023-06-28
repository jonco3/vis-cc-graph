export function assert (condition, message) {
  if (!condition) {
    if (!message) {
      message = 'Assertion failure';
    }
    throw message;
  }
}
