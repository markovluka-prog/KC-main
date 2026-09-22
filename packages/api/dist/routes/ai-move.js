import OpenAI from 'openai';
import { searchSettingsFor, searchTurnPlan } from './ai-search.js';
// ── Difficulty-specific system prompts ──────────────────────────────────────
const PROMPTS = {
    easy: `You are a WEAK AI opponent in a turn-based strategy game. You play carelessly.

Unit types:
- knight: melee (4 orthogonal dirs only), stays in place after attack, 2 moves
- samurai: melee (all 8 dirs: ortho + diagonal), stays in place after attack, 3 moves
- archer: ranged (shoots any enemy within 5x5 square zone), stays in place, 3 moves
- crossbow: same as archer but slightly more damage, 2 moves
- cavalry: jump attacker, lands BEYOND the target (or to the side via L-move), costs 2 moves
- catapult: long-range bombardment (manhattan distance 3-6), stays in place, 1 move

Special actions available per unit:
- spell: cast from a mage tower (costs artifacts from inventory, big area effect)
- craft: craft a weapon from artifacts (gives a unit bonus damage)
- ruins: search ruins for artifact loot (consumes the unit's full turn)

Combat: attacker_damage - target_armor = HP loss (if > 0). archer/crossbow always deal at least 1.

INSTRUCTIONS (play poorly on purpose):
- Ignore [KILLS!] moves - prefer moving aimlessly over attacking
- Often omit units from the plan entirely (act with 1-2 units max per turn)
- Never use spell, craft, or ruins actions

Return ONLY this JSON (no explanation, no markdown):
{"plan": [{"unitId": <number>, "actionIndex": <number>}, ...]}`,
    medium: `You are a competent AI opponent in a turn-based strategy game.

WIN CONDITION: Move any of your units into the enemy's 4×4 castle zone while no enemy unit defends it. You do NOT need to kill all enemies — capturing the undefended castle wins instantly.

Unit types:
- knight: melee (4 orthogonal dirs only), stays in place after attack, 2 moves. High armor (4) — use as frontline tank.
- samurai: melee (all 8 dirs: ortho + diagonal), stays in place after attack, 3 moves. Best melee attacker.
- archer: ranged (shoots any enemy within 5x5 square zone), stays in place, 3 moves. Cover bridges and chokepoints.
- crossbow: same zone as archer but more damage, 2 moves.
- cavalry: jump attacker, lands BEYOND the target (or to the side via L-attack), costs 2 moves. Best for castle raids and flanking.
- catapult: long-range bombardment (manhattan distance 3-6), stays in place, 1 move. Keep safe in the rear.

Special actions:
- spell: cast from a mage tower. "Sky of Fire" gives +2 damage to ALL your units for 2 turns — extremely powerful, use immediately.
- craft: craft a weapon. Sun Sword (+3 dmg, for knight/cavalry/samurai), Blue Bow (+2 dmg, for archer/crossbow). Equip right away.
- ruins: search ruins for artifact loot (consumes the unit's full turn). Worth doing when passing through center.

Combat: attacker_damage - target_armor = HP loss (if > 0). archer/crossbow always deal at least 1.
Only 3 units can be activated per turn — choose them wisely.

STRATEGIC PRIORITIES:
1. Take [KILLS!] opportunities when safe — fewer enemy units = easier castle capture
2. Keep 1 knight or samurai near your own castle to block enemy raids
3. Send cavalry toward the enemy castle when their defense looks thin
4. Use spell actions immediately — damage buff "Sky of Fire" is game-changing
5. Search ruins when a unit stands on them to gather spell ingredients
6. Position archers near bridges to punish enemy river crossings
7. Avoid leaving units exposed where they can be killed next turn
8. RETREAT from archer fire across a river — if an enemy archer or crossbow is shooting at one of your units from the other side of the river and you cannot kill it this turn, move your unit out of its 5×5 zone rather than standing still taking free damage every turn

Return ONLY this JSON (no explanation, no markdown):
{"plan": [{"unitId": <number>, "actionIndex": <number>}, ...]}`,
    hard: `You are a ruthless expert AI opponent in a turn-based strategy game. Crush the enemy.

WIN CONDITION: Move any unit into the enemy's 4×4 castle zone while no enemy unit defends it. You do NOT need to kill everyone — an undefended castle capture wins instantly. Force the enemy to split attention between defending their castle and fighting you in the field.

Unit types:
- knight: melee (4 orthogonal dirs only), stays in place after attack, 2 moves. Armor 4 — the best frontline tank. Use as a wall to absorb hits while ranged units fire from behind.
- samurai: melee (all 8 dirs: ortho + diagonal), stays in place after attack, 3 moves. Covers diagonals — place it to threaten multiple enemies at once.
- archer: ranged (5×5 square zone, no line-of-sight restriction), stays in place, 3 moves. Position near bridges and chokepoints — enemies cannot cross without taking fire.
- crossbow: same 5×5 zone as archer but higher damage, 2 moves. Priority target for the enemy; protect it.
- cavalry: jump attacker (costs 2 moves), lands beyond or to the side of the target. BEST unit for castle raids — 3 moves, fast, can bypass frontlines. Always check where it lands after a jump.
- catapult: long-range bombardment (manhattan 3-6, flies over everything), costs 1 move. Keep it deep in your rear — it is untouchable by melee and fires every turn.

Special actions:
- spell: cast from a mage tower (unit must stand on a tower tile). "Sky of Fire" gives +2 damage to ALL your units for 2 turns — combine with a mass attack for devastating kills. Always cast when available.
- craft: craft a weapon from artifacts. Sun Sword (+3 dmg per hit, 3 charges) for knight/cavalry/samurai; Blue Bow (+2 dmg, 2 charges) for archer/crossbow. Equip immediately to maximize value.
- ruins: search center ruins for loot. Sends the unit into ruins for the whole turn — worth it for artifact accumulation. Always do it when standing there.

Combat: attacker_damage - target_armor = HP loss (if > 0). archer/crossbow always deal at least 1 (armor-piercing).
Only 3 units can be activated per turn. Spend activations on the highest-impact actions only.

STRATEGIC INSTRUCTIONS (play optimally):
1. CASTLE RAID: Always evaluate if cavalry can reach the enemy castle zone. If the enemy has no defender there, send cavalry immediately — that wins the game.
2. HOME DEFENSE: Keep at least 1 unit (knight or samurai) within your own castle zone at all times. Never leave your castle empty.
3. KILL PRIORITY: Eliminate high-value targets first. Priority: cavalry > samurai > crossbow > archer > catapult > knight. Fewer enemy units = easier to raid their castle.
4. COMBO KILLS: Weaken a target with one unit so another can finish it. Use [KILLS!] markers — always execute kill moves before regular attacks.
5. FOCUS FIRE: Two units attacking one isolated enemy is more effective than spreading attacks. Surround and kill one unit per turn rather than chipping everyone.
6. SPELL TIMING: Cast "Sky of Fire" (+2 damage all, 2 turns) before a mass assault — not reactively. With the buff, cavalry (6+2=8 dmg) one-shots knights through armor.
7. CATAPULT SAFETY: Never move the catapult into melee range. It fires every turn from the rear — keep it alive.
8. ARCHER POSITIONING: Place archers to cover bridge crossings. The 5×5 zone means an archer can punish all units within 2 cells in every direction without moving.
9. CRAFT PRIORITY: Equip Sun Sword to cavalry or samurai for maximum burst. Blue Bow on crossbow turns it into a high-damage sniper.
10. USE ALL 3 ACTIVATIONS: Never end a turn with unused activations when units can still act — every wasted move is an advantage surrendered.
11. RETREAT FROM RIVER ARCHERS: If an enemy archer or crossbow is shooting at one of your units from across a river and you cannot kill it this turn, move that unit out of its 5×5 zone immediately. Do NOT stand still taking free damage — the river protects the shooter and you will lose the unit for nothing.

Return ONLY this JSON (no explanation, no markdown):
{"plan": [{"unitId": <number>, "actionIndex": <number>}, ...]}`,
};
const TEMPERATURES = {
    easy: 0.9,
    medium: 0.4,
    hard: 0.1,
};
// ── Helpers ──────────────────────────────────────────────────────────────────
function formatPrompt(body) {
    const { myUnits, enemyUnits, inventory, damageBuff, shieldTurns } = body;
    const lines = [];
    if (damageBuff && damageBuff > 0)
        lines.push(`YOUR DAMAGE BUFF: ${damageBuff} turn(s) remaining (+2 damage to all your units)`);
    if (shieldTurns && shieldTurns > 0)
        lines.push(`YOUR SHIELD: ${shieldTurns} turn(s) remaining (-2 damage received by all your units)`);
    if (inventory) {
        const arts = Object.entries(inventory).filter(([, n]) => n > 0);
        if (arts.length > 0)
            lines.push(`YOUR ARTIFACTS: ${arts.map(([name, n]) => `${name}x${n}`).join(', ')}`);
    }
    lines.push('\nENEMY UNITS:');
    if (enemyUnits.length === 0) {
        lines.push('  (none)');
    }
    else {
        for (const u of enemyUnits) {
            lines.push(`  ${u.type} #${u.id} at (row ${u.row}, col ${u.col}) - HP: ${u.hp}/${u.maxHp}, armor: ${u.armor}, dmg: ${u.damage}`);
        }
    }
    lines.push('\nYOUR UNITS:');
    for (const u of myUnits) {
        lines.push(`  ${u.type} #${u.id} at (row ${u.row}, col ${u.col}) - HP: ${u.hp}/${u.maxHp}, armor: ${u.armor}, dmg: ${u.damage}, moves left: ${u.movesLeft}`);
        if (u.availableActions.length === 0) {
            lines.push('    (no actions available)');
        }
        else {
            lines.push('    Available actions:');
            u.availableActions.forEach((a, i) => {
                lines.push(`    [${i}] ${a.desc}`);
            });
        }
    }
    return lines.join('\n');
}
function parseLLMResponse(content, myUnits) {
    try {
        const match = content.match(/\{[\s\S]*\}/);
        if (!match)
            return [];
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed.plan))
            return [];
        const result = [];
        for (const item of parsed.plan) {
            if (typeof item.unitId !== 'number' || typeof item.actionIndex !== 'number')
                continue;
            const unit = myUnits.find((u) => u.id === item.unitId);
            if (!unit)
                continue;
            const action = unit.availableActions[item.actionIndex];
            if (!action)
                continue;
            result.push({ unitId: item.unitId, action });
        }
        return result;
    }
    catch {
        return [];
    }
}
/**
 * Last-resort fallback when the search itself produces nothing (e.g. a position
 * where every unit's only listed action scores as actively harmful). Guarantees
 * the route never returns an empty plan while units can still act.
 */
function firstActionFallback(myUnits) {
    return myUnits
        .filter((u) => u.availableActions.length > 0)
        .map((u) => ({ unitId: u.id, action: u.availableActions[0] }));
}
/**
 * Tactical search fallback. Replaces what used to be "every unit performs its
 * first available action" — effectively random play, and the path every
 * deployment without a local model or an OpenRouter key actually took.
 *
 * The search only ever picks from the client's own `availableActions`, so the
 * plan is legal by construction. It reasons about material and threats; it
 * cannot reason about castle capture, because the request carries no map
 * (see ai-search.ts). That makes it a strong stand-in for a missing LLM, not a
 * replacement for the full client-side engine.
 */
function searchFallback(body) {
    const settings = searchSettingsFor(body.difficulty ?? 'medium');
    const plan = searchTurnPlan({
        myUnits: body.myUnits,
        enemyUnits: body.enemyUnits,
        damageBuff: body.damageBuff,
        shieldTurns: body.shieldTurns,
        ...settings,
    });
    return plan.length > 0 ? plan : firstActionFallback(body.myUnits);
}
function makeClient(baseURL, apiKey, headers) {
    return new OpenAI({ apiKey, baseURL, defaultHeaders: headers });
}
/**
 * ApiFreeLLM (https://apifreellm.com) — free tier.
 *
 * Deliberately NOT routed through the OpenAI SDK: on the free tier the
 * OpenAI-compatible endpoint (/api/v1/chat/completions) answers
 * `403 premium_required`. The free endpoint is a simpler shape:
 *
 *   POST /api/v1/chat
 *   Authorization: Bearer <key>          (x-api-key is rejected)
 *   { "message": "<the whole prompt>" }
 *   -> { "success": true, "response": "<text>" }
 *
 * It has no system/user role split and no temperature, so the difficulty
 * prompt and the board description are concatenated into one message. Verified
 * to return the strict `{"plan":[...]}` JSON the existing parser expects.
 *
 * Rate limiting: the free tier answers 429 with `retryAfter` seconds. We honour
 * it, but only within `maxWaitMs` — a game turn cannot hang indefinitely, and
 * the MCTS fallback below is a perfectly good answer.
 */
async function callApiFreeLLM(apiKey, systemPrompt, userPrompt, baseUrl, maxWaitMs) {
    const deadline = Date.now() + maxWaitMs;
    const message = `${systemPrompt}\n\n${userPrompt}`;
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            throw new Error('ApiFreeLLM: rate-limit wait budget exhausted');
        const res = await fetch(`${baseUrl}/api/v1/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ message }),
            signal: AbortSignal.timeout(Math.min(remaining, 30_000)),
        });
        const data = (await res.json().catch(() => ({})));
        if (res.status === 429) {
            const waitMs = Math.max(1, data.retryAfter ?? 5) * 1000 + 500;
            if (waitMs > deadline - Date.now()) {
                throw new Error(`ApiFreeLLM: rate limited, retryAfter ${data.retryAfter}s exceeds budget`);
            }
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
        }
        if (!res.ok || data.success === false) {
            throw new Error(`ApiFreeLLM: ${res.status} ${data.error ?? 'request failed'}`);
        }
        return data.response ?? '';
    }
}
/**
 * One OpenAI-compatible chat completion.
 *
 * `jsonMode` asks the provider to constrain the reply to a JSON object. Every
 * prompt here already demands strict JSON, but without the constraint a model
 * can still wrap it in prose or a markdown fence and fall through to the
 * fallback for no reason. Only pass it for providers known to support
 * `response_format` — Ollama's OpenAI shim rejects unknown fields.
 */
async function callLLM(client, model, systemPrompt, userPrompt, temperature, jsonMode = false) {
    const completion = await client.chat.completions.create({
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: 600,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });
    return completion.choices[0]?.message.content ?? '';
}
// ── Route ─────────────────────────────────────────────────────────────────────
const aiMovePlugin = async (app) => {
    app.post('/ai-move', async (req, reply) => {
        const { myUnits, difficulty = 'medium' } = req.body;
        if (myUnits.length === 0) {
            return reply.send({ plan: [] });
        }
        const systemPrompt = PROMPTS[difficulty] ?? PROMPTS.medium;
        const temperature = TEMPERATURES[difficulty] ?? 0.4;
        const userPrompt = formatPrompt(req.body);
        const ollamaBase = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
        const ollamaModel = process.env.OLLAMA_MODEL ?? 'llama3.2';
        const openrouterKey = process.env.OPENROUTER_API_KEY;
        const groqKey = process.env.GROQ_API_KEY;
        const groqBase = process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1';
        const groqModel = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
        const freeLlmKey = process.env.APIFREELLM_API_KEY;
        const freeLlmBase = process.env.APIFREELLM_BASE_URL ?? 'https://apifreellm.com';
        // The free tier rate-limits per key; wait at most this long for a slot
        // before giving up and letting the local search answer instead.
        const freeLlmMaxWaitMs = Number(process.env.APIFREELLM_MAX_WAIT_MS ?? 8000);
        // 1. Try Ollama (local — no limits, no key)
        try {
            const text = await callLLM(makeClient(`${ollamaBase}/v1`, 'ollama'), ollamaModel, systemPrompt, userPrompt, temperature);
            const plan = parseLLMResponse(text, myUnits);
            if (plan.length > 0) {
                app.log.debug({ source: 'ollama', difficulty }, 'LLM response');
                return reply.send({ plan });
            }
            // Model returned empty/invalid plan — fall through to next source.
            app.log.warn({ source: 'ollama', preview: text.slice(0, 200) }, 'LLM returned empty plan');
        }
        catch (err) {
            app.log.warn({ err }, 'Ollama unavailable, trying next provider');
        }
        // 2. Try Groq (free hosted model, OpenAI-compatible, ~250 ms/turn).
        // Placed above ApiFreeLLM because it is the only hosted option fast enough
        // to sit in a turn without the player noticing: measured 6 consecutive
        // turns at ~250 ms with no rate limiting, against ApiFreeLLM's enforced
        // 10-20 s gap between requests.
        if (groqKey) {
            try {
                const text = await callLLM(makeClient(groqBase, groqKey), groqModel, systemPrompt, userPrompt, temperature, true);
                const plan = parseLLMResponse(text, myUnits);
                if (plan.length > 0) {
                    app.log.debug({ source: 'groq', difficulty }, 'LLM response');
                    return reply.send({ plan });
                }
                app.log.warn({ source: 'groq', preview: text.slice(0, 200) }, 'LLM returned empty plan');
            }
            catch (err) {
                app.log.warn({ err }, 'Groq unavailable, trying next provider');
            }
        }
        // 3. Try ApiFreeLLM (free hosted model — key only, no card)
        if (freeLlmKey) {
            try {
                const text = await callApiFreeLLM(freeLlmKey, systemPrompt, userPrompt, freeLlmBase, freeLlmMaxWaitMs);
                const plan = parseLLMResponse(text, myUnits);
                if (plan.length > 0) {
                    app.log.debug({ source: 'apifreellm', difficulty }, 'LLM response');
                    return reply.send({ plan });
                }
                app.log.warn({ source: 'apifreellm', preview: text.slice(0, 200) }, 'LLM returned empty plan');
            }
            catch (err) {
                app.log.warn({ err }, 'ApiFreeLLM unavailable, trying OpenRouter');
            }
        }
        // 4. Try OpenRouter (cloud fallback)
        if (openrouterKey) {
            try {
                const model = process.env.OPENROUTER_MODEL ?? 'meta-llama/llama-3.1-8b-instruct:free';
                const text = await callLLM(makeClient(process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1', openrouterKey, {
                    'HTTP-Referer': 'https://knights-castles.app',
                    'X-Title': 'Knights & Castles',
                }), model, systemPrompt, userPrompt, temperature);
                const plan = parseLLMResponse(text, myUnits);
                if (plan.length > 0) {
                    app.log.debug({ source: 'openrouter', difficulty }, 'LLM response');
                    return reply.send({ plan });
                }
                app.log.warn({ source: 'openrouter', preview: text.slice(0, 200) }, 'LLM returned empty plan');
            }
            catch (err) {
                app.log.error({ err }, 'OpenRouter also failed; using heuristic fallback');
            }
        }
        // 5. Tactical search fallback — always produces a non-empty plan when units
        // can act, and plays a real game rather than dumping first actions.
        app.log.debug({ source: 'mcts', difficulty }, 'using search fallback');
        return reply.send({ plan: searchFallback(req.body) });
    });
};
// Plain plugin (no fastify-plugin wrapper) so the `/api` prefix in main.ts is honoured.
export const registerAIMoveRoute = aiMovePlugin;
