# ME-DandD

## Development, persistence and campaign transfer

Run `npm ci`, `npm test`, then `npm start` (Node 22 recommended). Tests exercise real Socket.IO clients, identity/GM permissions, dice, campaign consent and a server restart.

Lobby state is stored atomically in `.data/lobbies.json`; set `DND_STATE_FILE` to move it onto a persistent disk. This includes characters, maps, campaigns, chat history and identity reservations. MongoDB is optional metadata storage; full gameplay persistence uses the local snapshot. Single-server deployment is supported; multiple writers must not share one snapshot file.

A resume token in session storage binds player identity for the current browser tab and restores it after reconnect/reload. Lobby passwords protect new joins. A reserved name alone cannot claim GM privileges. Keep the resume token private; this is a lobby identity mechanism rather than a full account system. Leave Lobby releases the current connection.

Campaign export downloads JSON. GM import validates unique scene IDs and choice destinations and resets the campaign start state. Campaign start, edits, password changes, kicks and bans are enforced by the server. Choices wait for active player consent, with a GM force option. Zero HP is preserved, invalid dice and malformed requests are rejected, and encounter rounds advance on wrap.

## Ember Table overhaul

The table has a responsive dark/light interface with shared party cards, HP controls, conditions, inventories with quantities and weight, a session journal, quick dice and recent roll results. Only a character's owner or GM can change its HP, inventory, or conditions. Shared journal entries are attributed to the server-bound identity.

The GM desk adds private notes, four NPC presets (Goblin, Wolf, Ogre, Bandit), unique creature names, and forest/dungeon/courtyard map generation. Replacing a map requires a confirmation because it clears its tokens. Private notes are excluded from public state and sent only to the current GM socket.

Automatic encounters roll initiative for living characters and NPCs. The current player or GM can end a turn; finite condition durations expire on round rollover. Attacks require the attacker's turn and are limited to one per turn. Players can target NPCs; the GM controls attacks against party members. STR/DEX modifiers and proficiency affect the attack roll; natural 1 misses, natural 20 hits and adds another roll of the damage dice. Damage and critical damage use server-generated dice. This provides a basic encounter workflow rather than a complete tabletop rules engine; spellcasting and special class rules remain GM adjudications.

The local snapshot now also preserves inventories, conditions, NPCs, private notes, journal entries, and combat history. `npm test` runs 11 tests, including actual socket permissions and a restart recovering these additions. Browser validation exercises character creation, inventory changes, NPC creation, automatic encounters, GM notes, journals, quick dice, and mobile layout.
