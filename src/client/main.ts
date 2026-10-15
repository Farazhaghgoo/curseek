const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
canvas.width = innerWidth;
canvas.height = innerHeight;
ctx.fillStyle = '#05060a';
ctx.fillRect(0, 0, canvas.width, canvas.height);
