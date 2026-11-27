import { Game } from './game';

const game = new Game(document.getElementById('app')!);
// handy for poking at the game from the browser console
(window as unknown as { game: Game }).game = game;
