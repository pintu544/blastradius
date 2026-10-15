export default class App {
  static render(): void {
    console.log('rendering');
  }

  helper(): void {
    this.cleanup();
  }

  private cleanup(): void {
    console.log('clean');
  }
}
