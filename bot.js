/**
 * Exon External — Discord Bot
 *
 * Features:
 *  - /checkkey @user         → show if a user has a linked license (staff/dev only)
 *  - /mykeys                 → DMs you your active keys
 *  - Auto-assigns Member role on server join
 *
 * Install:
 *   npm install discord.js better-sqlite3 dotenv
 *
 * Register slash commands once:
 *   node bot.js --register
 *
 * Then run normally:
 *   node bot.js
 */

require('dotenv').config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const Database = require('better-sqlite3');
const path     = require('path');

// ── Shared database (same file as server.js) ─────────────────────────────────

const db = new Database(path.join(__dirname, 'data', 'exon.db'));
db.pragma('journal_mode = WAL');

const getUser     = db.prepare('SELECT * FROM users WHERE discord_id = ?');
const getUserKeys = db.prepare('SELECT * FROM keys WHERE discord_id = ? AND active = 1 ORDER BY created_at DESC');

// ── Role colors ───────────────────────────────────────────────────────────────

const ROLE_COLORS = {
  member:    0x6B7280,
  customer:  0xF07A12,
  staff:     0x4A90D9,
  developer: 0x9B59B6,
};

const ROLE_LABELS = {
  member:    'Member',
  customer:  'Customer',
  staff:     'Staff',
  developer: 'Developer',
};

// ── Slash command definitions ─────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('checkkey')
    .setDescription('Check if a user has an active Exon license (staff only)')
    .addUserOption(opt =>
      opt.setName('user')
         .setDescription('The Discord user to check')
         .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('mykeys')
    .setDescription('DM you your active Exon license keys')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Manually verify a license key and link it to your account')
    .addStringOption(opt =>
      opt.setName('key')
         .setDescription('Your license key (exon-XXXX-XXXX-XXXX-...)')
         .setRequired(true)
    )
    .toJSON(),
];

// ── Register commands (run with --register flag) ───────────────────────────────

if (process.argv.includes('--register')) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  (async () => {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered.');
    process.exit(0);
  })();
  return;
}

// ── Bot client ────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once('ready', () => {
  console.log(`Bot ready as ${client.user.tag}`);
});

// ── Auto-assign Member role on join ───────────────────────────────────────────

client.on('guildMemberAdd', async member => {
  const roleId = process.env.DISCORD_ROLE_MEMBER;
  if (!roleId) return;
  try {
    await member.roles.add(roleId);
    console.log(`Assigned Member role to ${member.user.tag}`);
  } catch (err) {
    console.error('Member role error:', err.message);
  }
});

// ── Slash command handler ─────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // ── /checkkey ──────────────────────────────────────────────────────────────
  if (interaction.commandName === 'checkkey') {
    await interaction.deferReply({ ephemeral: true });

    const target  = interaction.options.getUser('user');
    const dbUser  = getUser.get(target.id);
    const keys    = dbUser ? getUserKeys.all(target.id) : [];
    const role    = dbUser?.role ?? 'none';
    const color   = ROLE_COLORS[role] ?? 0x404858;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL() })
      .setTitle('License Check')
      .addFields(
        { name: 'Account Role', value: ROLE_LABELS[role] ?? 'Not registered', inline: true },
        { name: 'Active Keys',  value: String(keys.length), inline: true },
      );

    if (keys.length > 0) {
      const keyList = keys.map(k =>
        `\`${k.key_value}\` — ${k.plan ?? 'License'}`
      ).join('\n');
      embed.addFields({ name: 'Keys', value: keyList });
    }

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── /mykeys ────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'mykeys') {
    await interaction.deferReply({ ephemeral: true });

    const dbUser = getUser.get(interaction.user.id);
    const keys   = dbUser ? getUserKeys.all(interaction.user.id) : [];

    if (keys.length === 0) {
      await interaction.editReply('You have no active keys linked. Visit **exoncheats.com**, log in with Discord, and paste your key to link it.');
      return;
    }

    const keyList = keys.map((k, i) =>
      `**${i + 1}.** \`${k.key_value}\` — ${k.plan ?? 'License'}`
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor(ROLE_COLORS.customer)
      .setTitle('Your Active Keys')
      .setDescription(keyList)
      .setFooter({ text: 'Keep these private.' });

    try {
      await interaction.user.send({ embeds: [embed] });
      await interaction.editReply('Sent to your DMs.');
    } catch {
      await interaction.editReply({ embeds: [embed] });
    }
    return;
  }

  // ── /verify ────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'verify') {
    await interaction.deferReply({ ephemeral: true });

    const keyValue = interaction.options.getString('key').trim();
    const keyRow   = db.prepare('SELECT * FROM keys WHERE key_value = ?').get(keyValue);

    if (!keyRow) {
      await interaction.editReply('Key not found. Double-check the key and try again.');
      return;
    }
    if (!keyRow.active) {
      await interaction.editReply('That key is no longer active.');
      return;
    }
    if (keyRow.discord_id) {
      if (keyRow.discord_id === interaction.user.id) {
        await interaction.editReply('That key is already linked to your account.');
      } else {
        await interaction.editReply('That key is already linked to a different account.');
      }
      return;
    }

    // Link the key
    db.prepare('UPDATE keys SET discord_id = ? WHERE key_value = ?').run(interaction.user.id, keyValue);

    // Ensure user exists in DB
    db.prepare(`
      INSERT OR IGNORE INTO users (discord_id, username, avatar)
      VALUES (?, ?, ?)
    `).run(
      interaction.user.id,
      interaction.user.username,
      interaction.user.displayAvatarURL({ size: 128 })
    );

    // Promote to customer
    const dbUser = getUser.get(interaction.user.id);
    const roleOrder = ['member', 'customer', 'staff', 'developer'];
    if (!dbUser || roleOrder.indexOf(dbUser.role) < roleOrder.indexOf('customer')) {
      db.prepare('UPDATE users SET role = ? WHERE discord_id = ?').run('customer', interaction.user.id);
    }

    // Assign buyer role in Discord
    const buyerRoleId = process.env.DISCORD_ROLE_CUSTOMER;
    if (buyerRoleId) {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        await member.roles.add(buyerRoleId);
      } catch (err) {
        console.error('Buyer role error:', err.message);
      }
    }

    await interaction.editReply(`Key verified and linked to your account. You've been granted the **Customer** role. Welcome!`);
    return;
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_BOT_TOKEN);
