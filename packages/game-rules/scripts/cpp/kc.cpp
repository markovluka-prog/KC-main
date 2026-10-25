// Knights & Castles — C++ port of the rules engine (@kc/game-rules) for search.
//
// Covers everything the search uses: the full legal-action generator
// (generateActionsForPlayer + end turn) and the reducer (applyAction) for
// every action it emits — moves (archer runs, cavalry river leap), all four
// attack modes (shot / jump / L-attack / crossbow pierce), catapult bridge
// shots, tower range/damage, the 5 mage abilities with wards and overdraw
// death, crafting, castle healing, tower/bridge building, buried loot,
// dropped backpacks, gear equip rules and the castle-capture win check.
//
// Verified against the JS engine number-for-number by verify.py (perft
// counts from the real start and from crowded fight positions).
//
// Build: g++ -O3 -march=native -pthread kc.cpp -o kc
// Usage: ./kc perft <stateFile> <depth> [threads]
//        ./kc dfs   <stateFile> [threads] [tableLog2]
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

constexpr int N = 20, CELLS = 400, MAXU = 24, MAXP = 32, MAXD = 32;
enum Type : uint8_t { KNIGHT, CAVALRY, ARCHER, CATAPULT, CROSSBOW, SAMURAI, MAGE };
// Terrain cell byte: bits0-2 type (0 plain,1 river,2 mountain,3 bridge,4 rock),
// bit3 tower, bits4-5 bridge durability, bits6-7 site (0 none,1 tower,2 bridge).
enum Ter : uint8_t { PLAIN = 0, RIVER = 1, MOUNTAIN = 2, BRIDGE = 3, ROCK = 4 };
constexpr int TYPE_MOVES[] = {2, 3, 3, 2, 2, 3, 2};
constexpr int MAGE_MAX_ENERGY = 20, MAGE_REGEN = 5, MAX_ACT = 3;
enum Part { METAL, AMULET, RUBY, WOOD, ARROWS };

struct Unit {
  int8_t id, player, type, row, col, hp, maxHp, armor, maxArmor, startArmor, damage, maxMoves, moves;
  int8_t done, activated, energy, maxEnergy, wardedBy, weapon, armorGear;  // weapon 0/1 sword/2 bow; armour 0/1 mail/2 plate
  int8_t bp[5];
};
struct Pickup { int8_t row, col, kind, name; };           // kind 0 part,1 weapon,2 armour
struct Pack { int8_t row, col, bp[5], weapon, armorGear; };

struct State {
  uint8_t cell[CELLS];
  Unit u[MAXU];
  Pickup pk[MAXP];
  Pack pa[MAXD];
  int8_t nu = 0, npk = 0, npa = 0;
  int8_t player = 1, actCount = 0, winner = 0, c1 = 8, c2 = 8;
};

// ── catalogue ───────────────────────────────────────────────────────────────
// weapons: 1 sword (+3, forbid archer/catapult/crossbow), 2 bow (+2, only archer/crossbow)
// armour : 1 mail (+2, anyone), 2 plate (+4, forbid archer/crossbow/catapult)
constexpr int W_AMOUNT[] = {0, 3, 2}, A_AMOUNT[] = {0, 2, 4};
const int8_t W_RECIPE[3][5] = {{0}, {2, 1, 1, 0, 0}, {1, 1, 0, 2, 2}};  // Металл Амулет Рубин Дерево Стрелы
const int8_t A_RECIPE[3][5] = {{0}, {0, 0, 0, 1, 1}, {1, 0, 1, 0, 1}};
inline bool canWearWeapon(int w, int type) {
  if (w == 1) return type != ARCHER && type != CATAPULT && type != CROSSBOW;
  return type == ARCHER || type == CROSSBOW;
}
inline bool canWearArmor(int a, int type) {
  if (a == 1) return true;
  return type != ARCHER && type != CROSSBOW && type != CATAPULT;
}

// ── actions ─────────────────────────────────────────────────────────────────
enum Kind : uint8_t { MOVE, ATTACK, END, CRAFT, CRAFT_ARMOR, CASTLE_HEAL, M_ATTACK, M_WARD, M_DRAIN, M_HEAL, M_BURN, BUILD_TOWER, BUILD_BRIDGE };
enum Mode : uint8_t { SHOT, JUMP, LATTACK, PIERCE };
struct Action {
  uint8_t kind, mode;
  int8_t unit;          // index into State::u
  int8_t r, c;          // move dest / target / build cell
  int8_t lr, lc;        // landing
  int8_t cost, arg;     // arg: craft index, mage damage, target unit index
  int8_t pr[2], pc[2], np;  // pierce line
};

inline bool inside(int r, int c) { return r >= 0 && r < N && c >= 0 && c < N; }
inline int ter(const State& s, int r, int c) { return s.cell[r * N + c] & 7; }
inline bool isTower(const State& s, int r, int c) { return s.cell[r * N + c] & 8; }
inline int site(const State& s, int r, int c) { return s.cell[r * N + c] >> 6; }

// unit index at a cell, -1 if none (alive units only — dead ones are removed)
inline int unitAt(const State& s, const int8_t* grid, int r, int c) { return grid[r * N + c]; }
inline void buildGrid(const State& s, int8_t* grid) {
  std::memset(grid, -1, CELLS);
  for (int i = 0; i < s.nu; i++) grid[s.u[i].row * N + s.u[i].col] = i;
}
inline bool isFree(const State& s, const int8_t* grid, int r, int c) {
  if (!inside(r, c) || grid[r * N + c] >= 0) return false;
  int t = ter(s, r, c);
  if (t == RIVER || t == MOUNTAIN || t == ROCK) return false;
  return site(s, r, c) == 0;
}

static const int OD[4][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
static const int AD[8][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}, {-1, -1}, {-1, 1}, {1, -1}, {1, 1}};

inline int archerRadius(bool tower) { return tower ? 3 : 2; }  // round(2*1.5)
inline int catapultMax(bool tower) { return tower ? 9 : 6; }   // round(6*1.5)
inline int castleRow(int p) { return p == 1 ? 0 : N - 4; }
inline int castleCol(const State& s, int p) { return p == 1 ? s.c1 : s.c2; }
inline bool inCastle(int r, int c, int cr, int cc) { return r >= cr && r < cr + 4 && c >= cc && c < cc + 4; }

int gen(const State& s, Action* out) {
  int k = 0;
  int8_t grid[CELLS];
  buildGrid(s, grid);
  for (int i = 0; i < s.nu; i++) {
    const Unit& x = s.u[i];
    if (x.player != s.player || x.done || x.moves <= 0) continue;
    if (!x.activated && s.actCount >= MAX_ACT) continue;
    // moves
    for (auto& d : OD) {
      for (int st = 1; st <= x.maxMoves; st++) {
        if (st > x.moves) break;
        int r = x.row + d[0] * st, c = x.col + d[1] * st;
        if (!isFree(s, grid, r, c)) break;
        out[k++] = Action{MOVE, 0, int8_t(i), int8_t(r), int8_t(c), 0, 0, int8_t(st), 0, {}, {}, 0};
        if (x.type != ARCHER) break;
      }
    }
    if (x.type == CAVALRY && x.moves >= 2) {
      for (auto& d : OD) {
        int wr = x.row + d[0], wc = x.col + d[1];
        if (!inside(wr, wc) || ter(s, wr, wc) != RIVER) continue;
        int lr = x.row + d[0] * 2, lc = x.col + d[1] * 2;
        if (inside(lr, lc) && ter(s, lr, lc) == RIVER) continue;
        if (!isFree(s, grid, lr, lc)) continue;
        out[k++] = Action{MOVE, 0, int8_t(i), int8_t(lr), int8_t(lc), 0, 0, 2, 0, {}, {}, 0};
      }
    }
    // attacks
    bool tower = isTower(s, x.row, x.col);
    auto enemyAt = [&](int r, int c) -> bool {
      if (!inside(r, c)) return false;
      int j = grid[r * N + c];
      return j >= 0 && s.u[j].player != x.player;
    };
    if (x.type == ARCHER) {
      int R = archerRadius(tower);
      for (int dr = -R; dr <= R; dr++)
        for (int dc = -R; dc <= R; dc++) {
          if (!dr && !dc) continue;
          int cost = std::max(std::abs(dr), std::abs(dc));
          if (x.moves < cost) continue;
          int r = x.row + dr, c = x.col + dc;
          if (!enemyAt(r, c)) continue;
          out[k++] = Action{ATTACK, SHOT, int8_t(i), int8_t(r), int8_t(c), x.row, x.col, int8_t(cost), 0, {}, {}, 0};
        }
    } else if (x.type == CROSSBOW) {
      if (x.moves >= 2)
        for (auto& d : AD) {
          Action a{ATTACK, PIERCE, int8_t(i), 0, 0, x.row, x.col, 2, 0, {}, {}, 0};
          bool hit = false;
          for (int st = 1; st <= 2; st++) {
            int r = x.row + d[0] * st, c = x.col + d[1] * st;
            if (!inside(r, c)) break;
            a.pr[a.np] = r, a.pc[a.np] = c, a.np++;
            if (grid[r * N + c] >= 0) hit = true;
          }
          if (!a.np || !hit) continue;
          a.r = a.pr[0], a.c = a.pc[0];
          out[k++] = a;
        }
    } else if (x.type == CATAPULT) {
      int M = catapultMax(tower);
      for (int dr = -M; dr <= M; dr++)
        for (int dc = -M; dc <= M; dc++) {
          int dist = std::abs(dr) + std::abs(dc);
          if (dist < 3 || dist > M) continue;
          int r = x.row + dr, c = x.col + dc;
          if (!inside(r, c)) continue;
          int j = grid[r * N + c];
          bool enemy = j >= 0 && s.u[j].player != x.player;
          bool bridge = j < 0 && ter(s, r, c) == BRIDGE;
          if (!enemy && !bridge) continue;
          out[k++] = Action{ATTACK, SHOT, int8_t(i), int8_t(r), int8_t(c), x.row, x.col, 1, 0, {}, {}, 0};
        }
    } else if (x.type == KNIGHT || x.type == SAMURAI) {
      int nd = x.type == KNIGHT ? 4 : 8;
      for (int q = 0; q < nd; q++) {
        int r = x.row + AD[q][0], c = x.col + AD[q][1];
        if (enemyAt(r, c)) out[k++] = Action{ATTACK, SHOT, int8_t(i), int8_t(r), int8_t(c), x.row, x.col, 1, 0, {}, {}, 0};
      }
    } else if (x.type == CAVALRY && x.moves >= 2) {
      for (auto& d : OD) {
        int er = x.row + d[0], ec = x.col + d[1];
        if (!enemyAt(er, ec)) continue;
        int jr = er + d[0], jc = ec + d[1];
        if (isFree(s, grid, jr, jc)) out[k++] = Action{ATTACK, JUMP, int8_t(i), int8_t(er), int8_t(ec), int8_t(jr), int8_t(jc), 2, 0, {}, {}, 0};
        int p[2][2] = {{d[1], d[0]}, {-d[1], -d[0]}};
        for (auto& q : p) {
          int lr = er + q[0], lc = ec + q[1];
          if (isFree(s, grid, lr, lc)) out[k++] = Action{ATTACK, LATTACK, int8_t(i), int8_t(er), int8_t(ec), int8_t(lr), int8_t(lc), 2, 0, {}, {}, 0};
        }
      }
    }
    // economy / support (movesLeft >= 1 is guaranteed above)
    for (int w = 1; w <= 2; w++) {
      bool ok = true;
      for (int p = 0; p < 5; p++) ok &= x.bp[p] >= W_RECIPE[w][p];
      if (ok) out[k++] = Action{CRAFT, 0, int8_t(i), 0, 0, 0, 0, 1, int8_t(w - 1), {}, {}, 0};
    }
    for (int a = 1; a <= 2; a++) {
      bool ok = true;
      for (int p = 0; p < 5; p++) ok &= x.bp[p] >= A_RECIPE[a][p];
      if (ok) out[k++] = Action{CRAFT_ARMOR, 0, int8_t(i), 0, 0, 0, 0, 1, int8_t(a - 1), {}, {}, 0};
    }
    if (inCastle(x.row, x.col, castleRow(x.player), castleCol(s, x.player)) && (x.hp < x.maxHp || x.armor < x.maxArmor))
      out[k++] = Action{CASTLE_HEAL, 0, int8_t(i), 0, 0, 0, 0, 1, 0, {}, {}, 0};
    if (x.type == MAGE) {
      int energy = x.energy;
      for (int j = 0; j < s.nu; j++) {
        const Unit& o = s.u[j];
        int cheb = std::max(std::abs(o.row - x.row), std::abs(o.col - x.col));
        if (o.player != x.player) {
          int maxD = energy - cheb;
          if (maxD >= 1) {
            out[k++] = Action{M_ATTACK, 0, int8_t(i), o.row, o.col, 0, 0, 1, int8_t(maxD), {}, {}, 0};
            if (maxD > 1) out[k++] = Action{M_ATTACK, 0, int8_t(i), o.row, o.col, 0, 0, 1, 1, {}, {}, 0};
          }
          if (cheb <= 1 && o.hp > 1 && (!o.wardedBy || o.wardedBy == x.id))
            out[k++] = Action{M_DRAIN, 0, int8_t(i), 0, 0, 0, 0, 1, int8_t(j), {}, {}, 0};
        } else {
          if (cheb == 1 && o.hp > 1) out[k++] = Action{M_DRAIN, 0, int8_t(i), 0, 0, 0, 0, 1, int8_t(j), {}, {}, 0};
          if (o.hp < o.maxHp && energy >= (o.maxHp - o.hp) + cheb)
            out[k++] = Action{M_HEAL, 0, int8_t(i), 0, 0, 0, 0, 1, int8_t(j), {}, {}, 0};
        }
      }
      for (int j = 0; j < s.nu; j++)
        if (s.u[j].player == x.player) out[k++] = Action{M_WARD, 0, int8_t(i), 0, 0, 0, 0, 1, int8_t(j), {}, {}, 0};
      for (int r = 0; r < N; r++)
        for (int c = 0; c < N; c++) {
          if (ter(s, r, c) != BRIDGE || grid[r * N + c] >= 0) continue;
          int cheb = std::max(std::abs(r - x.row), std::abs(c - x.col));
          if (energy >= cheb * 2) out[k++] = Action{M_BURN, 0, int8_t(i), int8_t(r), int8_t(c), 0, 0, 1, 0, {}, {}, 0};
        }
    }
    if (x.type == KNIGHT && x.moves == 2) {
      for (auto& d : OD) {
        int r = x.row + d[0], c = x.col + d[1];
        if (!inside(r, c)) continue;
        int st = site(s, r, c);
        if (st) {
          out[k++] = Action{uint8_t(st == 1 ? BUILD_TOWER : BUILD_BRIDGE), 0, int8_t(i), int8_t(r), int8_t(c), 0, 0, 2, 0, {}, {}, 0};
          continue;
        }
        bool occ = grid[r * N + c] >= 0;
        int t = ter(s, r, c);
        bool blocked = t == MOUNTAIN || t == ROCK || t == RIVER || t == BRIDGE;
        if (t == RIVER && !occ) out[k++] = Action{BUILD_BRIDGE, 0, int8_t(i), int8_t(r), int8_t(c), 0, 0, 2, 0, {}, {}, 0};
        else if (!blocked && !occ && !isTower(s, r, c)) out[k++] = Action{BUILD_TOWER, 0, int8_t(i), int8_t(r), int8_t(c), 0, 0, 2, 0, {}, {}, 0};
      }
    }
  }
  out[k++] = Action{END, 0, -1, 0, 0, 0, 0, 0, 0, {}, {}, 0};
  return k;
}

// ── reducer helpers ─────────────────────────────────────────────────────────
inline int findId(const State& s, int id) {
  for (int i = 0; i < s.nu; i++) if (s.u[i].id == id) return i;
  return -1;
}
inline void removeUnit(State& s, int i) {
  for (int j = i; j < s.nu - 1; j++) s.u[j] = s.u[j + 1];
  s.nu--;
}
inline void equipWeapon(Unit& x, int w) { x.damage += W_AMOUNT[w]; x.weapon = w; }
inline void equipArmor(Unit& x, int a) { x.armor += A_AMOUNT[a]; x.maxArmor += A_AMOUNT[a]; x.armorGear = a; }
inline void dropPack(State& s, int r, int c, const int8_t* bp, int w, int a) {
  Pack p{int8_t(r), int8_t(c), {0, 0, 0, 0, 0}, int8_t(w), int8_t(a)};
  if (bp) std::memcpy(p.bp, bp, 5);
  if (s.npa < MAXD) s.pa[s.npa++] = p;
}
inline void dropUnitBackpack(State& s, const Unit& x) {
  bool any = x.weapon || x.armorGear;
  for (int p = 0; p < 5; p++) any |= x.bp[p] > 0;
  if (any) dropPack(s, x.row, x.col, x.bp, x.weapon, x.armorGear);
}
inline void clearWards(State& s, int mageId) {
  for (int i = 0; i < s.nu; i++) if (s.u[i].wardedBy == mageId) s.u[i].wardedBy = 0;
}
void maybeFinish(State& s) {
  if (s.winner) return;
  bool a = false, b = false;
  for (int i = 0; i < s.nu; i++) {
    const Unit& x = s.u[i];
    if (!inCastle(x.row, x.col, N - 4, s.c2)) continue;
    (x.player == 1 ? a : b) = true;
  }
  if (a && !b) { s.winner = 1; return; }
  a = b = false;
  for (int i = 0; i < s.nu; i++) {
    const Unit& x = s.u[i];
    if (!inCastle(x.row, x.col, 0, s.c1)) continue;
    (x.player == 2 ? a : b) = true;
  }
  if (a && !b) s.winner = 2;
}
/** Ward check before a hit on unit `t` (index); returns true if absorbed. May remove the mage (indices shift!). */
bool absorb(State& s, int& t, int raw) {
  Unit& tu = s.u[t];
  if (!tu.wardedBy) return false;
  int m = findId(s, tu.wardedBy);
  if (m < 0 || s.u[m].type != MAGE) { tu.wardedBy = 0; return false; }
  Unit& mu = s.u[m];
  if (mu.energy >= raw) { mu.energy -= raw; return true; }
  int mid = mu.id, tid = tu.id;
  dropUnitBackpack(s, mu);
  clearWards(s, mid);
  removeUnit(s, m);
  t = findId(s, tid);
  maybeFinish(s);
  return true;
}
void claimPickup(State& s, int i) {
  Unit& x = s.u[i];
  for (int q = 0; q < s.npk; q++) {
    if (s.pk[q].row != x.row || s.pk[q].col != x.col) continue;
    Pickup p = s.pk[q];
    for (int j = q; j < s.npk - 1; j++) s.pk[j] = s.pk[j + 1];
    s.npk--;
    if (p.kind == 0) { x.bp[(int)p.name]++; return; }
    if (p.kind == 1) {
      if (!x.weapon && canWearWeapon(p.name, x.type)) equipWeapon(x, p.name);
      else dropPack(s, x.row, x.col, nullptr, p.name, 0);
    } else {
      if (!x.armorGear && canWearArmor(p.name, x.type)) equipArmor(x, p.name);
      else dropPack(s, x.row, x.col, nullptr, 0, p.name);
    }
    return;
  }
}
void pickUp(State& s, int i) {
  Unit& x = s.u[i];
  int keep = 0;
  Pack out[MAXD];
  for (int q = 0; q < s.npa; q++) {
    Pack p = s.pa[q];
    if (p.row != x.row || p.col != x.col) { out[keep++] = p; continue; }
    for (int z = 0; z < 5; z++) x.bp[z] += p.bp[z];
    int w = p.weapon, a = p.armorGear;
    if (w && !x.weapon && canWearWeapon(w, x.type)) { equipWeapon(x, w); w = 0; }
    if (a && !x.armorGear && canWearArmor(a, x.type)) { equipArmor(x, a); a = 0; }
    if (w || a) out[keep++] = Pack{p.row, p.col, {0, 0, 0, 0, 0}, int8_t(w), int8_t(a)};
  }
  std::memcpy(s.pa, out, sizeof(Pack) * keep);
  s.npa = keep;
}
inline void activate(State& s, Unit& x) {
  if (!x.activated) { x.activated = 1; s.actCount++; }
}
inline void spend(Unit& x, int n) { x.moves -= n; if (x.moves <= 0) x.done = 1; }
inline void sinkLoot(State& s, int r, int c) {
  int keep = 0;
  for (int q = 0; q < s.npa; q++) if (!(s.pa[q].row == r && s.pa[q].col == c)) s.pa[keep++] = s.pa[q];
  s.npa = keep;
}
inline void destroyBridge(State& s, int r, int c) {
  s.cell[r * N + c] = (s.cell[r * N + c] & 8) | RIVER;  // keep tower bit (never set on bridges), durability cleared
  sinkLoot(s, r, c);
}
/** Damage `dmg` (after ward) to unit index t; kills drop loot, clear wards and remove. */
void hit(State& s, int t, int dmg) {
  Unit& v = s.u[t];
  if (dmg > v.armor) { v.hp -= dmg - v.armor; v.armor = 0; }
  else v.armor -= dmg;
}
inline bool isRanged(int t) { return t == ARCHER || t == CROSSBOW || t == CATAPULT; }

void endTurn(State& s) {
  int next = s.player == 1 ? 2 : 1;
  for (int i = 0; i < s.nu; i++) {
    Unit& x = s.u[i];
    x.activated = 0;
    if (x.player == next) {
      x.done = 0;
      x.moves = TYPE_MOVES[(int)x.type];
      if (x.type == MAGE) x.energy = std::min<int>(x.maxEnergy ? x.maxEnergy : MAGE_MAX_ENERGY, x.energy + MAGE_REGEN);
    }
  }
  s.actCount = 0;
  s.player = next;
}

/** applyAction for every kind gen() emits. Returns false if the reducer would reject it. */
bool apply(State& s, const Action& a) {
  if (a.kind == END) { if (!s.winner) endTurn(s); return true; }
  int i = a.unit;
  Unit* x = &s.u[i];
  if (!x->activated && s.actCount >= MAX_ACT) return false;
  switch (a.kind) {
    case MOVE: {
      activate(s, *x);
      x->row = a.r, x->col = a.c;
      spend(*x, a.cost);
      claimPickup(s, i);
      pickUp(s, i);
      maybeFinish(s);
      return true;
    }
    case ATTACK: {
      int8_t grid[CELLS];
      buildGrid(s, grid);
      bool tower = isTower(s, x->row, x->col);
      if (a.mode == PIERCE) {
        activate(s, *x);
        int dmg = x->damage;
        if (tower) dmg = std::max(1, (int)std::floor(dmg * 0.65 + 0.5));
        int ids[2], n = 0;
        for (int q = 0; q < a.np; q++) { int j = grid[a.pr[q] * N + a.pc[q]]; if (j >= 0) ids[n++] = s.u[j].id; }
        int attackerId = x->id;
        for (int q = 0; q < n; q++) {
          int t = findId(s, ids[q]);
          if (t < 0 || s.u[t].hp <= 0) continue;
          int hd = dmg;
          if (hd == 0 && s.u[findId(s, attackerId)].damage > 0) hd = 1;
          if (absorb(s, t, hd)) continue;
          hit(s, t, hd);
          if (s.u[t].hp <= 0) {
            dropUnitBackpack(s, s.u[t]);
            if (s.u[t].type == MAGE) clearWards(s, s.u[t].id);
          }
        }
        for (int t = s.nu - 1; t >= 0; t--) if (s.u[t].hp <= 0) removeUnit(s, t);
        maybeFinish(s);
        int ai = findId(s, attackerId);
        spend(s.u[ai], a.cost);
        return true;
      }
      int t = grid[a.r * N + a.c];
      if (t < 0) {  // catapult at an empty bridge
        activate(s, *x);
        int cell = a.r * N + a.c;
        int hpLeft = (((s.cell[cell] >> 4) & 3) ? ((s.cell[cell] >> 4) & 3) : 2) - 1;
        if (hpLeft <= 0) destroyBridge(s, a.r, a.c);
        else s.cell[cell] = (s.cell[cell] & ~0x30) | (hpLeft << 4);
        spend(*x, a.cost);
        return true;
      }
      activate(s, *x);
      if (a.mode == JUMP || a.mode == LATTACK) x->row = a.lr, x->col = a.lc;
      int dmg = x->damage;
      if (tower && isRanged(x->type)) dmg = std::max(1, (int)std::floor(dmg * 0.65 + 0.5));
      if ((x->type == ARCHER || x->type == CROSSBOW) && dmg == 0 && x->damage > 0) dmg = 1;
      spend(*x, a.cost);
      int attackerId = x->id, targetId = s.u[t].id;
      if (absorb(s, t, dmg)) {
        if (a.mode == JUMP || a.mode == LATTACK) {
          int ai = findId(s, attackerId);
          if (ai >= 0) { claimPickup(s, ai); pickUp(s, ai); }
        }
        return true;
      }
      hit(s, t, dmg);
      if (s.u[t].hp <= 0) {
        dropUnitBackpack(s, s.u[t]);
        if (s.u[t].type == MAGE) clearWards(s, targetId);
        removeUnit(s, t);
        maybeFinish(s);
      }
      if (a.mode == JUMP || a.mode == LATTACK) {
        int ai = findId(s, attackerId);
        claimPickup(s, ai);
        pickUp(s, ai);
      }
      return true;
    }
    case CRAFT: {
      int w = a.arg + 1;
      activate(s, *x);
      for (int p = 0; p < 5; p++) x->bp[p] -= W_RECIPE[w][p];
      x->moves = std::max(0, x->moves - 1);
      if (x->moves <= 0) x->done = 1;
      if (!x->weapon && canWearWeapon(w, x->type)) equipWeapon(*x, w);
      else dropPack(s, x->row, x->col, nullptr, w, 0);
      return true;
    }
    case CRAFT_ARMOR: {
      int ar = a.arg + 1;
      activate(s, *x);
      for (int p = 0; p < 5; p++) x->bp[p] -= A_RECIPE[ar][p];
      x->moves = std::max(0, x->moves - 1);
      if (x->moves <= 0) x->done = 1;
      if (!x->armorGear && canWearArmor(ar, x->type)) equipArmor(*x, ar);
      else dropPack(s, x->row, x->col, nullptr, 0, ar);
      return true;
    }
    case CASTLE_HEAL:
      activate(s, *x);
      x->hp = x->maxHp, x->armor = x->maxArmor, x->moves = 0, x->done = 1;
      return true;
    case M_ATTACK: {
      int8_t grid[CELLS];
      buildGrid(s, grid);
      int t = grid[a.r * N + a.c];
      int cheb = std::max(std::abs(a.r - x->row), std::abs(a.c - x->col));
      int cost = a.arg + cheb;
      activate(s, *x);
      x->energy -= cost;
      spend(*x, 1);
      int targetId = s.u[t].id;
      if (absorb(s, t, a.arg)) return true;
      hit(s, t, a.arg);
      if (s.u[t].hp <= 0) {
        dropUnitBackpack(s, s.u[t]);
        if (s.u[t].type == MAGE) clearWards(s, targetId);
        removeUnit(s, t);
        maybeFinish(s);
      }
      return true;
    }
    case M_WARD: {
      Unit& y = s.u[a.arg];
      activate(s, *x);
      y.wardedBy = y.wardedBy == x->id ? 0 : x->id;
      spend(*x, 1);
      return true;
    }
    case M_DRAIN: {
      int t = a.arg;
      if (s.u[t].wardedBy && s.u[t].wardedBy != x->id) return false;  // reducer rejects
      int mageId = x->id;
      activate(s, *x);
      if (absorb(s, t, 1)) {
        int mi = findId(s, mageId);
        if (mi >= 0) spend(s.u[mi], 1);
        return true;
      }
      s.u[t].hp -= 1;
      x->energy = std::min<int>(x->maxEnergy ? x->maxEnergy : MAGE_MAX_ENERGY, x->energy + 5);
      spend(*x, 1);
      return true;
    }
    case M_HEAL: {
      Unit& y = s.u[a.arg];
      int cheb = std::max(std::abs(y.row - x->row), std::abs(y.col - x->col));
      int cost = (y.maxHp - y.hp) + cheb;
      activate(s, *x);
      y.hp = y.maxHp;
      x->energy -= cost;
      spend(*x, 1);
      return true;
    }
    case M_BURN: {
      int cheb = std::max(std::abs(a.r - x->row), std::abs(a.c - x->col));
      activate(s, *x);
      destroyBridge(s, a.r, a.c);
      x->energy -= cheb * 2;
      spend(*x, 1);
      return true;
    }
    case BUILD_TOWER:
    case BUILD_BRIDGE: {
      activate(s, *x);
      x->moves = 0, x->done = 1;
      int cell = a.r * N + a.c;
      if (site(s, a.r, a.c)) {  // progress was 2 → now 4: finished
        s.cell[cell] &= 0x3f;
        if (a.kind == BUILD_TOWER) s.cell[cell] |= 8;
        else s.cell[cell] = (s.cell[cell] & ~0x37) | BRIDGE | (2 << 4);
      } else {
        s.cell[cell] |= (a.kind == BUILD_TOWER ? 1 : 2) << 6;
      }
      return true;
    }
  }
  return false;
}

// ── state I/O ───────────────────────────────────────────────────────────────
bool load(const char* path, State& s, std::vector<uint64_t>& perft) {
  std::ifstream f(path);
  std::string tag;
  int ver;
  if (!(f >> tag >> ver) || tag != "KCSTATE") return false;
  int p, ac, c1, c2;
  f >> p >> ac >> c1 >> c2;
  s.player = p, s.actCount = ac, s.c1 = c1, s.c2 = c2, s.winner = 0;
  for (int i = 0; i < CELLS; i++) { int v; f >> v; s.cell[i] = v; }
  int n;
  f >> tag >> n;
  s.nu = n;
  for (int i = 0; i < n; i++) {
    int v[25];
    for (int& x : v) f >> x;
    Unit& u = s.u[i];
    u = Unit{int8_t(v[0]), int8_t(v[1]), int8_t(v[2]), int8_t(v[3]), int8_t(v[4]), int8_t(v[5]), int8_t(v[6]), int8_t(v[7]),
             int8_t(v[8]), int8_t(v[9]), int8_t(v[10]), int8_t(v[11]), int8_t(v[12]), int8_t(v[13]), int8_t(v[14]), int8_t(v[15]),
             int8_t(v[16]), int8_t(v[17]), int8_t(v[23]), int8_t(v[24]), {int8_t(v[18]), int8_t(v[19]), int8_t(v[20]), int8_t(v[21]), int8_t(v[22])}};
  }
  f >> tag >> n;
  s.npk = n;
  for (int i = 0; i < n; i++) { int r, c, k, nm; f >> r >> c >> k >> nm; s.pk[i] = {int8_t(r), int8_t(c), int8_t(k), int8_t(nm)}; }
  f >> tag >> n;
  s.npa = n;
  for (int i = 0; i < n; i++) {
    int v[9];
    for (int& x : v) f >> x;
    s.pa[i] = {int8_t(v[0]), int8_t(v[1]), {int8_t(v[2]), int8_t(v[3]), int8_t(v[4]), int8_t(v[5]), int8_t(v[6])}, int8_t(v[7]), int8_t(v[8])};
  }
  if (f >> tag && tag == "PERFT") {
    int k;
    f >> k;
    for (int i = 0; i < k; i++) { uint64_t c; f >> c; perft.push_back(c); }
  }
  return true;
}

// ── perft ───────────────────────────────────────────────────────────────────
uint64_t perft(const State& s, int d) {
  if (d == 0 || s.winner) return 1;
  Action acts[512];
  int k = gen(s, acts);
  uint64_t n = 0;
  for (int i = 0; i < k; i++) {
    State c = s;
    if (apply(c, acts[i])) n += perft(c, d - 1);
  }
  return n;
}

int main(int argc, char** argv) {
  if (argc < 3) { fprintf(stderr, "usage: kc perft <state> <depth> [threads]\n"); return 2; }
  std::string mode = argv[1];
  State root;
  std::vector<uint64_t> expect;
  if (!load(argv[2], root, expect)) { fprintf(stderr, "bad state file\n"); return 2; }
  if (mode == "perft") {
    int depth = atoi(argv[3]);
    int threads = argc > 4 ? atoi(argv[4]) : (int)std::thread::hardware_concurrency();
    for (int d = 1; d <= depth; d++) {
      auto t0 = std::chrono::steady_clock::now();
      Action acts[512];
      int k = gen(root, acts);
      std::atomic<int> next{0};
      std::atomic<uint64_t> total{0};
      std::vector<std::thread> pool;
      for (int t = 0; t < threads; t++)
        pool.emplace_back([&] {
          for (int i; (i = next++) < k;) {
            State c = root;
            if (apply(c, acts[i])) total += perft(c, d - 1);
          }
        });
      for (auto& th : pool) th.join();
      double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
      printf("DEPTH %d %llu %.3f", d, (unsigned long long)total.load(), sec);
      if (d <= (int)expect.size()) printf(" JS %llu %s", (unsigned long long)expect[d - 1], expect[d - 1] == total ? "OK" : "MISMATCH");
      printf("\n");
      fflush(stdout);
    }
    return 0;
  }
  fprintf(stderr, "unknown mode\n");
  return 2;
}
