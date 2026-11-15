// One-time (and after any change): registers the three global slash commands with Discord. Run it on YOUR computer; the bot token is read from the
// environment and goes only to discord.com. It is never written to a file, a log or the repository.
//   DISCORD_BOT_TOKEN=... DISCORD_APP_ID=... node scripts/discord-register-commands.mjs
const token = process.env.DISCORD_BOT_TOKEN;
const appId = process.env.DISCORD_APP_ID;
if (!token || !appId || !/^\d{17,20}$/.test(appId)) {
  console.error("Set DISCORD_BOT_TOKEN and DISCORD_APP_ID (a number) in the environment first.");
  process.exit(1);
}
const commands = [
  { name: "link", description: "Link your Esports Hub account (get the code in the app)", type: 1, options: [{ type: 3, name: "code", description: "The 8 character code from the app", required: true, max_length: 20 }] },
  { name: "team", description: "Show the link to your team's private channel", type: 1 },
  { name: "dispute", description: "Open the dispute page in the Esports Hub app", type: 1 },
];
const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "PUT",
  headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
console.log(res.ok ? `Registered ${commands.length} commands.` : `Discord answered ${res.status}: ${(await res.text()).replace(token, "[token]").slice(0, 300)}`);
process.exit(res.ok ? 0 : 1);
