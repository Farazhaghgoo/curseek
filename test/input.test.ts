import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Input, STICK_RADIUS, type Stick } from '../src/client/input';

/** Just enough of the DOM for Input: event targets, matchMedia and pointer capture. */
function setup() {
  const g = globalThis as Record<string, unknown>;
  g.window = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) });
  g.document = new EventTarget();
  const canvas = Object.assign(new EventTarget(), { requestPointerLock: () => {}, setPointerCapture: () => {} });
  const input = new Input(canvas as unknown as HTMLCanvasElement);
  const sticks: (Stick | null)[] = [];
  input.onStickChange = (s) => sticks.push(s);
  const pointer = (type: string, pointerType: string, x: number, y: number, pointerId = 1) =>
    canvas.dispatchEvent(Object.assign(new Event(type), { pointerType, pointerId, clientX: x, clientY: y }));
  return { input, sticks, pointer };
}

test('dragging a finger steers in proportion to the drag, up to full speed', () => {
  const { input, sticks, pointer } = setup();
  pointer('pointerdown', 'touch', 100, 100);
  assert.ok(input.touching);
  assert.ok(input.usesTouch);
  assert.deepEqual(sticks.at(-1), { ox: 100, oy: 100, x: 0, y: 0 });

  pointer('pointermove', 'touch', 100 + STICK_RADIUS / 2, 100);
  assert.deepEqual(input.direction(), { x: 0.5, y: 0 });
  pointer('pointermove', 'touch', 100, 100 - STICK_RADIUS * 3);
  assert.deepEqual(input.direction(), { x: 0, y: -1 }, 'capped at full speed');
  pointer('pointermove', 'touch', 103, 100);
  assert.deepEqual(input.direction(), { x: 0, y: 0 }, 'tiny drags are ignored');

  pointer('pointermove', 'touch', 300, 300, 2);
  pointer('pointerdown', 'touch', 300, 300, 2);
  assert.equal(sticks.at(-1)!.ox, 100, 'a second finger does not move the stick');

  pointer('pointerup', 'touch', 103, 100);
  assert.equal(input.touching, false);
  assert.equal(sticks.at(-1), null);
  assert.deepEqual(input.direction(), { x: 0, y: 0 });
});

test('a mouse press does not open the stick and switches back to mouse controls', () => {
  const { input, sticks, pointer } = setup();
  pointer('pointerdown', 'touch', 10, 10);
  pointer('pointerup', 'touch', 10, 10);
  pointer('pointerdown', 'mouse', 50, 50);
  assert.equal(input.touching, false);
  assert.equal(input.usesTouch, false);
  assert.equal(sticks.length, 2);
});
