// Exhaustive branch counter for Knights & Castles — the REAL starting army.
//
// Counts every distinct action sequence ("branch") of length d from the start
// position, for d = 1, 2, 3, ...  It models a SUBSET of the game: plain unit
// moves (each unit's real move rules), the 3-activations-per-turn limit and
// "end turn". Attacks, abilities, crafting and building are left out, so the
// real game tree is strictly LARGER than what this counts — every number it
// prints is a lower bound. That is all an impossibility proof needs.
//
// Output (one line each, parsed by prove_impossible.py):
//   PROGRESS <depth> <rootDone> <rootTotal> <nodes> <seconds>
//   DEPTH <depth> <branches> <seconds>
//
// Build: g++ -O3 -march=native -pthread perft.cpp -o perft
// Run:   ./perft <maxDepth> [threads]

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

constexpr int N = 20;          // 20×20 board
constexpr int CASTLE_COL = 8;  // both castles at cols 8..11
constexpr int MAX_ACT = 3;     // distinct units per turn

enum Type : uint8_t { KNIGHT, CAVALRY, ARCHER, MAGE };
constexpr int MAX_MOVES[] = {2, 3, 3, 2};

struct Unit {
  uint8_t row, col, player, type, moves, done, activated;
};

struct State {
  Unit u[22];
  int n = 0;
  uint8_t grid[N * N];  // 0 = free, else unit index + 1
  uint8_t player = 1, actCount = 0;
};

struct Move {
  int8_t unit;  // -1 = end turn
  uint8_t row, col, cost;
};

// START_POSITIONS_P1 from packages/game-rules/src/constants.ts
struct Pos { Type t; int r, c; };
constexpr Pos START[] = {
    {CAVALRY, 3, 1}, {CAVALRY, 3, 2}, {KNIGHT, 1, 0}, {KNIGHT, 1, 3}, {KNIGHT, 2, 0}, {KNIGHT, 2, 3},
    {KNIGHT, 0, 0},  {ARCHER, 0, 1},  {ARCHER, 0, 2}, {KNIGHT, 0, 3}, {MAGE, 2, 1},
};

State startState() {
  State s{};
  for (auto& g : s.grid) g = 0;
  for (int p = 1; p <= 2; ++p)
    for (auto& q : START) {
      Unit x{};
      x.player = p;
      x.type = q.t;
      x.row = p == 1 ? q.r : N - 1 - q.r;
      x.col = q.c + CASTLE_COL;
      x.moves = MAX_MOVES[q.t];
      s.u[s.n] = x;
      s.grid[x.row * N + x.col] = s.n + 1;
      ++s.n;
    }
  return s;
}

int genMoves(const State& s, Move* out) {
  int k = 0;
  static const int DR[] = {-1, 1, 0, 0}, DC[] = {0, 0, -1, 1};
  for (int i = 0; i < s.n; ++i) {
    const Unit& x = s.u[i];
    if (x.player != s.player || x.done || x.moves == 0) continue;
    if (!x.activated && s.actCount >= MAX_ACT) continue;
    int reach = x.type == ARCHER ? x.moves : 1;  // only the archer walks several cells at once
    for (int d = 0; d < 4; ++d)
      for (int st = 1; st <= reach; ++st) {
        int r = x.row + DR[d] * st, c = x.col + DC[d] * st;
        if (r < 0 || r >= N || c < 0 || c >= N || s.grid[r * N + c]) break;
        out[k++] = {int8_t(i), uint8_t(r), uint8_t(c), uint8_t(st)};
      }
  }
  out[k++] = {-1, 0, 0, 0};  // end turn is always legal
  return k;
}

struct Undo {
  Unit u[22];
  uint8_t player, actCount;
};

inline void apply(State& s, const Move& m, Undo& un) {
  if (m.unit < 0) {
    for (int i = 0; i < s.n; ++i) un.u[i] = s.u[i];
    un.player = s.player;
    un.actCount = s.actCount;
    uint8_t next = s.player == 1 ? 2 : 1;
    for (int i = 0; i < s.n; ++i) {
      s.u[i].activated = 0;
      if (s.u[i].player == next) {
        s.u[i].moves = MAX_MOVES[s.u[i].type];
        s.u[i].done = 0;
      }
    }
    s.player = next;
    s.actCount = 0;
    return;
  }
  Unit& x = s.u[m.unit];
  un.u[0] = x;
  un.actCount = s.actCount;
  s.grid[x.row * N + x.col] = 0;
  x.row = m.row;
  x.col = m.col;
  s.grid[x.row * N + x.col] = m.unit + 1;
  x.moves -= m.cost;
  if (!x.activated) {
    x.activated = 1;
    ++s.actCount;
  }
  if (x.moves == 0) x.done = 1;
}

inline void undo(State& s, const Move& m, const Undo& un) {
  if (m.unit < 0) {
    for (int i = 0; i < s.n; ++i) s.u[i] = un.u[i];
    s.player = un.player;
    s.actCount = un.actCount;
    return;
  }
  Unit& x = s.u[m.unit];
  s.grid[x.row * N + x.col] = 0;
  x = un.u[0];
  s.grid[x.row * N + x.col] = m.unit + 1;
  s.actCount = un.actCount;
}

std::atomic<uint64_t> gNodes{0};

uint64_t perft(State& s, int depth, uint64_t& local) {
  if (depth == 0) return 1;
  Move moves[256];
  int k = genMoves(s, moves);
  if (depth == 1) {
    local += k;
    return k;
  }
  uint64_t total = 0;
  Undo un;
  for (int i = 0; i < k; ++i) {
    apply(s, moves[i], un);
    total += perft(s, depth - 1, local);
    undo(s, moves[i], un);
    if ((++local & 0xFFFF) == 0) {
      gNodes += local;
      local = 0;
    }
  }
  return total;
}

int main(int argc, char** argv) {
  int maxDepth = argc > 1 ? atoi(argv[1]) : 7;
  int threads = argc > 2 ? atoi(argv[2]) : (int)std::thread::hardware_concurrency();
  if (threads < 1) threads = 1;
  auto t0 = std::chrono::steady_clock::now();
  auto secs = [&] { return std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count(); };

  State root = startState();
  Move rootMoves[256];
  int rootK = genMoves(root, rootMoves);

  for (int depth = 1; depth <= maxDepth; ++depth) {
    std::atomic<int> next{0}, done{0};
    std::atomic<uint64_t> total{0};
    std::atomic<bool> finished{false};
    std::vector<std::thread> pool;
    for (int t = 0; t < threads; ++t)
      pool.emplace_back([&] {
        State s = root;
        uint64_t local = 0;
        for (int i; (i = next++) < rootK;) {
          Undo un;
          apply(s, rootMoves[i], un);
          total += perft(s, depth - 1, local);
          undo(s, rootMoves[i], un);
          ++done;
        }
        gNodes += local;
      });
    std::thread reporter([&] {
      while (!finished) {
        printf("PROGRESS %d %d %d %llu %.2f\n", depth, done.load(), rootK, (unsigned long long)gNodes.load(), secs());
        fflush(stdout);
        for (int i = 0; i < 5 && !finished; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
    });
    for (auto& th : pool) th.join();
    finished = true;
    reporter.join();
    printf("DEPTH %d %llu %.3f\n", depth, (unsigned long long)total.load(), secs());
    fflush(stdout);
  }
  return 0;
}
