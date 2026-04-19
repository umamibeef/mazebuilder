import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Play, Pause, RotateCcw, Shuffle, Footprints, Wand2 } from "lucide-react";

type Direction = "N" | "E" | "S" | "W";

type Cell = {
  row: number;
  col: number;
  visited: boolean;
  walls: Record<Direction, boolean>;
};

type MazeStats = {
  visited: number;
  stackDepth: number;
  deadEnds: number;
  completion: number;
};

type MazeConfig = {
  rows: number;
  cols: number;
  cellSize: number;
  stepsPerTick: number;
  straightBias: number;
  horizontalBias: number;
  braidPercent: number;
  seed: number;
  animate: boolean;
};

type StepState = {
  grid: Cell[][];
  current: { row: number; col: number } | null;
  stack: Array<{ row: number; col: number }>;
  visitedCount: number;
  previousDirection: Direction | null;
  done: boolean;
};

const defaultConfig: MazeConfig = {
  rows: 20,
  cols: 28,
  cellSize: 22,
  stepsPerTick: 8,
  straightBias: 45,
  horizontalBias: 0,
  braidPercent: 0,
  seed: 1337,
  animate: true,
};

const directionVectors: Record<Direction, { dr: number; dc: number; opposite: Direction }> = {
  N: { dr: -1, dc: 0, opposite: "S" },
  E: { dr: 0, dc: 1, opposite: "W" },
  S: { dr: 1, dc: 0, opposite: "N" },
  W: { dr: 0, dc: -1, opposite: "E" },
};

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createGrid(rows: number, cols: number): Cell[][] {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => ({
      row,
      col,
      visited: false,
      walls: { N: true, E: true, S: true, W: true },
    })),
  );
}

function cloneGrid(grid: Cell[][]): Cell[][] {
  return grid.map((row) => row.map((cell) => ({ ...cell, walls: { ...cell.walls } })));
}

function inBounds(row: number, col: number, rows: number, cols: number): boolean {
  return row >= 0 && row < rows && col >= 0 && col < cols;
}

function removeWall(grid: Cell[][], row: number, col: number, direction: Direction): void {
  const current = grid[row][col];
  const vector = directionVectors[direction];
  const nextRow = row + vector.dr;
  const nextCol = col + vector.dc;
  current.walls[direction] = false;
  grid[nextRow][nextCol].walls[vector.opposite] = false;
}

function chooseWeightedDirection(
  directions: Direction[],
  previousDirection: Direction | null,
  horizontalBias: number,
  straightBias: number,
  rng: () => number,
): Direction {
  const weights = directions.map((direction) => {
    let weight = 1;
    if (direction === "E" || direction === "W") {
      weight *= 1 + horizontalBias / 100;
    } else {
      weight *= 1 - horizontalBias / 100;
    }

    if (previousDirection && direction === previousDirection) {
      weight *= 1 + straightBias / 100;
    }

    return Math.max(0.01, weight);
  });

  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let pick = rng() * total;

  for (let index = 0; index < directions.length; index += 1) {
    pick -= weights[index];
    if (pick <= 0) {
      return directions[index];
    }
  }

  return directions[directions.length - 1];
}

function getUnvisitedNeighbors(grid: Cell[][], row: number, col: number): Array<{ direction: Direction; row: number; col: number }> {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const results: Array<{ direction: Direction; row: number; col: number }> = [];

  (Object.keys(directionVectors) as Direction[]).forEach((direction) => {
    const vector = directionVectors[direction];
    const nextRow = row + vector.dr;
    const nextCol = col + vector.dc;
    if (inBounds(nextRow, nextCol, rows, cols) && !grid[nextRow][nextCol].visited) {
      results.push({ direction, row: nextRow, col: nextCol });
    }
  });

  return results;
}

function countDeadEnds(grid: Cell[][]): number {
  let deadEnds = 0;
  for (const row of grid) {
    for (const cell of row) {
      const openCount = (Object.keys(cell.walls) as Direction[]).filter((direction) => !cell.walls[direction]).length;
      if (openCount === 1) {
        deadEnds += 1;
      }
    }
  }
  return deadEnds;
}

function applyBraiding(grid: Cell[][], braidPercent: number, rng: () => number): void {
  if (braidPercent <= 0) {
    return;
  }

  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const deadEnds: Array<{ row: number; col: number }> = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const openCount = (Object.keys(grid[row][col].walls) as Direction[]).filter((direction) => !grid[row][col].walls[direction]).length;
      if (openCount === 1) {
        deadEnds.push({ row, col });
      }
    }
  }

  for (const deadEnd of deadEnds) {
    if (rng() > braidPercent / 100) {
      continue;
    }

    const candidates = (Object.keys(directionVectors) as Direction[])
      .map((direction) => ({ direction, vector: directionVectors[direction] }))
      .filter(({ direction, vector }) => {
        const nextRow = deadEnd.row + vector.dr;
        const nextCol = deadEnd.col + vector.dc;
        return inBounds(nextRow, nextCol, rows, cols) && grid[deadEnd.row][deadEnd.col].walls[direction];
      });

    if (candidates.length === 0) {
      continue;
    }

    const chosen = candidates[Math.floor(rng() * candidates.length)];
    removeWall(grid, deadEnd.row, deadEnd.col, chosen.direction);
  }
}

function initializeStepState(config: MazeConfig): { stepState: StepState; rng: () => number } {
  const grid = createGrid(config.rows, config.cols);
  const rng = mulberry32(config.seed);
  const startRow = Math.floor(rng() * config.rows);
  const startCol = Math.floor(rng() * config.cols);

  grid[startRow][startCol].visited = true;

  return {
    stepState: {
      grid,
      current: { row: startRow, col: startCol },
      stack: [{ row: startRow, col: startCol }],
      visitedCount: 1,
      previousDirection: null,
      done: false,
    },
    rng,
  };
}

function runBacktrackerStep(state: StepState, config: MazeConfig, rng: () => number): StepState {
  if (state.done || !state.current) {
    return state;
  }

  const nextState: StepState = {
    grid: cloneGrid(state.grid),
    current: state.current ? { ...state.current } : null,
    stack: [...state.stack],
    visitedCount: state.visitedCount,
    previousDirection: state.previousDirection,
    done: state.done,
  };

  const current = nextState.current;
  if (!current) {
    return nextState;
  }

  const { row, col } = current;
  const neighbors = getUnvisitedNeighbors(nextState.grid, row, col);

  if (neighbors.length > 0) {
    const direction = chooseWeightedDirection(
      neighbors.map((neighbor) => neighbor.direction),
      nextState.previousDirection,
      clamp(config.horizontalBias, -90, 90),
      clamp(config.straightBias, 0, 300),
      rng,
    );

    const picked = neighbors.find((neighbor) => neighbor.direction === direction);
    if (!picked) {
      return nextState;
    }

    removeWall(nextState.grid, row, col, direction);
    nextState.grid[picked.row][picked.col].visited = true;
    nextState.current = { row: picked.row, col: picked.col };
    nextState.stack.push({ row: picked.row, col: picked.col });
    nextState.visitedCount += 1;
    nextState.previousDirection = direction;
    return nextState;
  }

  nextState.stack.pop();
  if (nextState.stack.length === 0) {
    applyBraiding(nextState.grid, config.braidPercent, rng);
    nextState.current = null;
    nextState.done = true;
    nextState.previousDirection = null;
    return nextState;
  }

  nextState.current = nextState.stack[nextState.stack.length - 1];
  nextState.previousDirection = null;
  return nextState;
}

function buildMazeInstant(config: MazeConfig): Cell[][] {
  const { stepState, rng } = initializeStepState(config);
  let state = stepState;
  while (!state.done) {
    state = runBacktrackerStep(state, config, rng);
  }
  return state.grid;
}

function solveMaze(grid: Cell[][]): Set<string> {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const queue: Array<{ row: number; col: number }> = [{ row: 0, col: 0 }];
  const visited = new Set<string>(["0,0"]);
  const parent = new Map<string, string | null>();
  parent.set("0,0", null);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (current.row === rows - 1 && current.col === cols - 1) {
      break;
    }

    for (const direction of Object.keys(directionVectors) as Direction[]) {
      if (grid[current.row][current.col].walls[direction]) {
        continue;
      }
      const vector = directionVectors[direction];
      const nextRow = current.row + vector.dr;
      const nextCol = current.col + vector.dc;
      const key = `${nextRow},${nextCol}`;
      if (!visited.has(key)) {
        visited.add(key);
        parent.set(key, `${current.row},${current.col}`);
        queue.push({ row: nextRow, col: nextCol });
      }
    }
  }

  const path = new Set<string>();
  let cursor: string | null = `${rows - 1},${cols - 1}`;
  while (cursor && parent.has(cursor)) {
    path.add(cursor);
    cursor = parent.get(cursor) ?? null;
  }
  return path;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function SliderField({
  label,
  min,
  max,
  step,
  value,
  onChange,
  description,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  description: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <label className="text-sm font-medium text-slate-200">{label}</label>
        <div className="min-w-12 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-right font-mono text-xs text-slate-300">
          {value}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-800"
      />
      <p className="text-xs leading-5 text-slate-400">{description}</p>
    </div>
  );
}

export default function RecursiveBacktrackerMazePlayground() {
  const [config, setConfig] = useState<MazeConfig>(defaultConfig);
  const [isRunning, setIsRunning] = useState<boolean>(defaultConfig.animate);
  const [showSolution, setShowSolution] = useState<boolean>(false);
  const [mazeGrid, setMazeGrid] = useState<Cell[][]>(() => createGrid(defaultConfig.rows, defaultConfig.cols));
  const [currentCell, setCurrentCell] = useState<{ row: number; col: number } | null>(null);
  const [stats, setStats] = useState<MazeStats>({
    visited: 0,
    stackDepth: 0,
    deadEnds: 0,
    completion: 0,
  });
  const animationRef = useRef<number | null>(null);
  const rngRef = useRef<(() => number) | null>(null);
  const stepStateRef = useRef<StepState | null>(null);

  const debouncedConfig = useDebouncedValue(config, 120);

  const restart = useCallback((nextConfig: MazeConfig, shouldRun: boolean) => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    const { stepState, rng } = initializeStepState(nextConfig);
    stepStateRef.current = stepState;
    rngRef.current = rng;
    setMazeGrid(stepState.grid);
    setCurrentCell(stepState.current);
    setStats({
      visited: stepState.visitedCount,
      stackDepth: stepState.stack.length,
      deadEnds: 0,
      completion: Math.round((stepState.visitedCount / (nextConfig.rows * nextConfig.cols)) * 100),
    });
    setIsRunning(shouldRun);
    setShowSolution(false);

    if (!shouldRun) {
      const finalGrid = buildMazeInstant(nextConfig);
      stepStateRef.current = {
        grid: finalGrid,
        current: null,
        stack: [],
        visitedCount: nextConfig.rows * nextConfig.cols,
        previousDirection: null,
        done: true,
      };
      setMazeGrid(finalGrid);
      setCurrentCell(null);
      setStats({
        visited: nextConfig.rows * nextConfig.cols,
        stackDepth: 0,
        deadEnds: countDeadEnds(finalGrid),
        completion: 100,
      });
    }
  }, []);

  useEffect(() => {
    restart(debouncedConfig, debouncedConfig.animate);
  }, [debouncedConfig, restart]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    let disposed = false;

    const tick = () => {
      if (disposed || !stepStateRef.current || !rngRef.current) {
        return;
      }

      let state = stepStateRef.current;
      for (let step = 0; step < config.stepsPerTick && !state.done; step += 1) {
        state = runBacktrackerStep(state, config, rngRef.current);
      }

      stepStateRef.current = state;
      setMazeGrid(state.grid);
      setCurrentCell(state.current);
      setStats({
        visited: state.visitedCount,
        stackDepth: state.stack.length,
        deadEnds: state.done ? countDeadEnds(state.grid) : 0,
        completion: Math.round((state.visitedCount / (config.rows * config.cols)) * 100),
      });

      if (!state.done) {
        animationRef.current = requestAnimationFrame(tick);
      } else {
        animationRef.current = null;
        setIsRunning(false);
      }
    };

    animationRef.current = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [config, isRunning]);

  const path = useMemo(() => {
    if (!showSolution) {
      return new Set<string>();
    }
    return solveMaze(mazeGrid);
  }, [mazeGrid, showSolution]);

  const width = config.cols * config.cellSize;
  const height = config.rows * config.cellSize;

  const regenerate = () => {
    restart(config, config.animate);
  };

  const randomizeSeed = () => {
    const nextSeed = Math.floor(Math.random() * 1_000_000);
    setConfig((current) => ({ ...current, seed: nextSeed }));
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto grid max-w-7xl gap-6 p-6 lg:grid-cols-[360px,1fr]">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="border-slate-800 bg-slate-900/80 shadow-2xl shadow-slate-950/50 backdrop-blur">
            <CardHeader className="space-y-3">
              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-300">
                Recursive backtracker playground
              </div>
              <CardTitle className="text-2xl font-semibold tracking-tight text-white">Generate, bias, animate, and solve a maze</CardTitle>
              <p className="text-sm leading-6 text-slate-400">
                This demo carves a perfect maze by walking forward until it gets stuck, then backtracking through the stack. Adjust the knobs
                to change the maze personality.
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-2 gap-3">
                <Button onClick={() => setIsRunning((current) => !current)} className="rounded-2xl" variant="secondary" disabled={stepStateRef.current?.done ?? false}>
                  {isRunning ? <Pause className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
                  {isRunning ? "Pause" : "Run"}
                </Button>
                <Button onClick={regenerate} className="rounded-2xl">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Regenerate
                </Button>
                <Button onClick={randomizeSeed} variant="outline" className="rounded-2xl border-slate-700 bg-slate-950 text-slate-200">
                  <Shuffle className="mr-2 h-4 w-4" />
                  New seed
                </Button>
                <Button
                  onClick={() => setShowSolution((current) => !current)}
                  variant="outline"
                  className="rounded-2xl border-slate-700 bg-slate-950 text-slate-200"
                  disabled={!(stepStateRef.current?.done ?? false)}
                >
                  <Footprints className="mr-2 h-4 w-4" />
                  {showSolution ? "Hide solution" : "Show solution"}
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm">
                <div>
                  <div className="text-slate-400">Visited</div>
                  <div className="mt-1 font-mono text-lg text-white">{stats.visited}</div>
                </div>
                <div>
                  <div className="text-slate-400">Completion</div>
                  <div className="mt-1 font-mono text-lg text-white">{stats.completion}%</div>
                </div>
                <div>
                  <div className="text-slate-400">Stack depth</div>
                  <div className="mt-1 font-mono text-lg text-white">{stats.stackDepth}</div>
                </div>
                <div>
                  <div className="text-slate-400">Dead ends</div>
                  <div className="mt-1 font-mono text-lg text-white">{stats.deadEnds}</div>
                </div>
              </div>

              <div className="space-y-5">
                <SliderField
                  label="Rows"
                  min={6}
                  max={40}
                  value={config.rows}
                  onChange={(value) => setConfig((current) => ({ ...current, rows: value }))}
                  description="More rows increase complexity and vertical depth."
                />
                <SliderField
                  label="Columns"
                  min={6}
                  max={60}
                  value={config.cols}
                  onChange={(value) => setConfig((current) => ({ ...current, cols: value }))}
                  description="More columns create wider mazes and longer solution paths."
                />
                <SliderField
                  label="Cell size"
                  min={10}
                  max={32}
                  value={config.cellSize}
                  onChange={(value) => setConfig((current) => ({ ...current, cellSize: value }))}
                  description="Visual scale only. It does not change the carved topology."
                />
                <SliderField
                  label="Steps per frame"
                  min={1}
                  max={80}
                  value={config.stepsPerTick}
                  onChange={(value) => setConfig((current) => ({ ...current, stepsPerTick: value }))}
                  description="Higher values speed up the animation by doing more carving work each frame."
                />
                <SliderField
                  label="Straight bias"
                  min={0}
                  max={250}
                  value={config.straightBias}
                  onChange={(value) => setConfig((current) => ({ ...current, straightBias: value }))}
                  description="Prefers continuing in the same direction, which produces longer corridors."
                />
                <SliderField
                  label="Horizontal bias"
                  min={-90}
                  max={90}
                  value={config.horizontalBias}
                  onChange={(value) => setConfig((current) => ({ ...current, horizontalBias: value }))}
                  description="Negative values favor vertical travel. Positive values favor horizontal travel."
                />
                <SliderField
                  label="Braiding"
                  min={0}
                  max={100}
                  value={config.braidPercent}
                  onChange={(value) => setConfig((current) => ({ ...current, braidPercent: value }))}
                  description="Removes some dead ends after generation, adding loops to the perfect maze."
                />
              </div>

              <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm font-medium text-slate-200">Seed</label>
                  <input
                    type="number"
                    value={config.seed}
                    onChange={(event) => setConfig((current) => ({ ...current, seed: Number(event.target.value) || 0 }))}
                    className="w-36 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none ring-0 transition focus:border-cyan-500"
                  />
                </div>
                <label className="flex cursor-pointer items-center gap-3 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={config.animate}
                    onChange={(event) => setConfig((current) => ({ ...current, animate: event.target.checked }))}
                    className="h-4 w-4 rounded border-slate-700 bg-slate-900"
                  />
                  Animate generation instead of building instantly
                </label>
              </div>

              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <Wand2 className="h-4 w-4" />
                  What the knobs actually change
                </div>
                <ul className="space-y-1 text-amber-50/90">
                  <li>Higher straight bias usually creates fewer turns and longer hallways.</li>
                  <li>Horizontal bias lets you deliberately skew the maze’s texture.</li>
                  <li>Braiding adds loops, so the maze stops being a strict perfect maze.</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="h-full border-slate-800 bg-slate-900/80 shadow-2xl shadow-slate-950/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-xl font-semibold text-white">Live maze view</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-auto rounded-3xl border border-slate-800 bg-slate-950 p-4">
                <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="auto" className="mx-auto max-h-[78vh] rounded-2xl bg-slate-950" style={{ maxWidth: width }}>
                  <rect x={0} y={0} width={width} height={height} fill="#020617" />

                  {mazeGrid.flatMap((row) =>
                    row.map((cell) => {
                      const x = cell.col * config.cellSize;
                      const y = cell.row * config.cellSize;
                      const key = `${cell.row}-${cell.col}`;
                      const inPath = path.has(`${cell.row},${cell.col}`);
                      const isCurrent = currentCell?.row === cell.row && currentCell?.col === cell.col;

                      return (
                        <g key={key}>
                          <rect
                            x={x}
                            y={y}
                            width={config.cellSize}
                            height={config.cellSize}
                            fill={inPath ? "rgba(34,197,94,0.35)" : cell.visited ? "rgba(14,165,233,0.16)" : "transparent"}
                          />
                          {isCurrent && (
                            <rect
                              x={x + config.cellSize * 0.2}
                              y={y + config.cellSize * 0.2}
                              width={config.cellSize * 0.6}
                              height={config.cellSize * 0.6}
                              rx={config.cellSize * 0.15}
                              fill="rgba(250,204,21,0.92)"
                            />
                          )}
                          {cell.row === 0 && cell.col === 0 && (
                            <circle cx={x + config.cellSize / 2} cy={y + config.cellSize / 2} r={config.cellSize * 0.18} fill="rgba(34,197,94,0.9)" />
                          )}
                          {cell.row === config.rows - 1 && cell.col === config.cols - 1 && (
                            <circle cx={x + config.cellSize / 2} cy={y + config.cellSize / 2} r={config.cellSize * 0.18} fill="rgba(244,63,94,0.95)" />
                          )}
                          {cell.walls.N && <line x1={x} y1={y} x2={x + config.cellSize} y2={y} stroke="#e2e8f0" strokeWidth={2} />}
                          {cell.walls.E && (
                            <line x1={x + config.cellSize} y1={y} x2={x + config.cellSize} y2={y + config.cellSize} stroke="#e2e8f0" strokeWidth={2} />
                          )}
                          {cell.walls.S && <line x1={x} y1={y + config.cellSize} x2={x + config.cellSize} y2={y + config.cellSize} stroke="#e2e8f0" strokeWidth={2} />}
                          {cell.walls.W && <line x1={x} y1={y} x2={x} y2={y + config.cellSize} stroke="#e2e8f0" strokeWidth={2} />}
                        </g>
                      );
                    }),
                  )}
                </svg>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
