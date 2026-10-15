export function add(a, b) {
  return a + b;
}

export const sub = (a, b) => a - b;

function internal(x) {
  return x * 2;
}

export function doubled(n) {
  return internal(n);
}
