/**
 * Phase 4 T4.6 — zod schemas for action messages received over WS.
 * Tight whitelist: anything not matching is closed with reason and the
 * sender's session is flagged for review.
 */
import { z } from 'zod';
const AttackModeSchema = z.enum(['shot', 'jump', 'l-attack', 'pierce']);
const MoveAction = z.object({
    kind: z.literal('move'),
    unitId: z.number().int().nonnegative(),
    row: z.number().int().nonnegative().max(19),
    col: z.number().int().nonnegative().max(19),
    cost: z.number().int().positive(),
});
const PositionSchema = z.object({
    row: z.number().int().nonnegative().max(19),
    col: z.number().int().nonnegative().max(19),
});
const AttackAction = z.object({
    kind: z.literal('attack'),
    unitId: z.number().int().nonnegative(),
    mode: AttackModeSchema,
    cost: z.number().int().positive(),
    targetRow: z.number().int().nonnegative().max(19),
    targetCol: z.number().int().nonnegative().max(19),
    landingRow: z.number().int().nonnegative().max(19),
    landingCol: z.number().int().nonnegative().max(19),
    // `mode: 'pierce'` only — the crossbow's line of cells (see @kc/game-rules).
    targets: z.array(PositionSchema).max(4).optional(),
});
const EndTurnAction = z.object({ kind: z.literal('end-turn') });
const ResignAction = z.object({
    kind: z.literal('resign'),
    player: z.union([z.literal(1), z.literal(2)]),
});
const CraftAction = z.object({
    kind: z.literal('craft'),
    unitId: z.number().int().nonnegative(),
    index: z.number().int().nonnegative().max(10),
});
const CraftArmorAction = z.object({
    kind: z.literal('craft-armor'),
    unitId: z.number().int().nonnegative(),
    index: z.number().int().nonnegative().max(10),
});
const DrawPartAction = z.object({
    kind: z.literal('draw-part'),
    unitId: z.number().int().nonnegative(),
});
const EquipWeaponAction = z.object({
    kind: z.literal('equip-weapon'),
    unitId: z.number().int().nonnegative(),
});
const SearchRuinsAction = z.object({
    kind: z.literal('search-ruins'),
    unitId: z.number().int().nonnegative(),
});
const CastleHealAction = z.object({
    kind: z.literal('castle-heal'),
    unitId: z.number().int().nonnegative(),
});
const PartNameSchema = z.enum(['Металл', 'Амулет', 'Рубин', 'Дерево', 'Стрелы']);
const TransferItemsAction = z.object({
    kind: z.literal('transfer-items'),
    fromUnitId: z.number().int().nonnegative(),
    toUnitId: z.number().int().nonnegative(),
    parts: z.record(PartNameSchema, z.number().int()).optional(),
    weapon: z.boolean().optional(),
    armor: z.boolean().optional(),
});
const MageAttackAction = z.object({
    kind: z.literal('mage-attack'),
    unitId: z.number().int().nonnegative(),
    targetRow: z.number().int().nonnegative().max(19),
    targetCol: z.number().int().nonnegative().max(19),
});
const MageWardAction = z.object({
    kind: z.literal('mage-ward'),
    unitId: z.number().int().nonnegative(),
    wardUnitIds: z.array(z.number().int().nonnegative()).max(20),
});
const MageDrainAction = z.object({
    kind: z.literal('mage-drain'),
    unitId: z.number().int().nonnegative(),
    targetUnitId: z.number().int().nonnegative(),
});
const MageBurnBridgeAction = z.object({
    kind: z.literal('mage-burn-bridge'),
    unitId: z.number().int().nonnegative(),
    row: z.number().int().nonnegative().max(19),
    col: z.number().int().nonnegative().max(19),
});
const BuildTowerAction = z.object({
    kind: z.literal('build-tower'),
    unitId: z.number().int().nonnegative(),
    row: z.number().int().nonnegative().max(19),
    col: z.number().int().nonnegative().max(19),
});
const BuildBridgeAction = z.object({
    kind: z.literal('build-bridge'),
    unitId: z.number().int().nonnegative(),
    row: z.number().int().nonnegative().max(19),
    col: z.number().int().nonnegative().max(19),
});
export const ServerActionSchema = z.discriminatedUnion('kind', [
    MoveAction,
    AttackAction,
    EndTurnAction,
    ResignAction,
    CraftAction,
    CraftArmorAction,
    DrawPartAction,
    EquipWeaponAction,
    SearchRuinsAction,
    CastleHealAction,
    TransferItemsAction,
    MageAttackAction,
    MageWardAction,
    MageDrainAction,
    MageBurnBridgeAction,
    BuildTowerAction,
    BuildBridgeAction,
]);
export function parseAction(raw) {
    const r = ServerActionSchema.safeParse(raw);
    if (!r.success)
        return { ok: false, error: r.error.message };
    return { ok: true, value: r.data };
}
