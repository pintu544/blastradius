import { add } from './math.js';
import App from './app.js';

const total = add(2, 3);

function main() {
  console.log('total:', total);
  App.render();
}

main();
