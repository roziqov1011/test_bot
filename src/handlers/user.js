const { InlineKeyboard } = require('grammy');
const prisma = require('../db');

async function showProfile(ctx) {
    const userId = ctx.dbUser.id;

    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { results: true }
    });

    const totalTests = user.results.length;
    let totalScore = 0;
    let totalQuestions = 0;
    let totalTime = 0;

    user.results.forEach(res => {
        totalScore += res.score;
        totalQuestions += res.totalQuestions;
        totalTime += res.spentTime;
    });

    const accuracy = totalQuestions > 0 ? ((totalScore / totalQuestions) * 100).toFixed(1) : 0;
    const avgTime = totalTests > 0 ? Math.floor(totalTime / totalTests) : 0;

    const text = `👤 <b>Mening Profilim</b>\n\n` +
                 `Foydalanuvchi: ${user.firstName}\n` +
                 `Jami ishlangan testlar: <b>${totalTests} ta</b>\n` +
                 `Jami to'g'ri javoblar: <b>${totalScore} ta</b> (Umumiy: ${totalQuestions})\n` +
                 `O'rtacha aniqlik: <b>${accuracy}%</b>\n` +
                 `O'rtacha sarflangan vaqt: <b>${avgTime} sek/test</b>\n\n` +
                 `<i>Botimizdan foydalanayotganingiz uchun rahmat! O'z bilimingizni oshirishda davom eting!</i>`;

    const keyboard = new InlineKeyboard()
        .text('⬅️ Orqaga', 'start');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function showLeaderboard(ctx) {
    const results = await prisma.result.findMany({
        include: { user: true }
    });

    // Group by user and calculate total score
    const userScores = {};
    results.forEach(res => {
        if (!userScores[res.userId]) {
            userScores[res.userId] = {
                name: res.user.firstName || 'Foydalanuvchi',
                totalScore: 0,
                testsTaken: 0
            };
        }
        userScores[res.userId].totalScore += res.score;
        userScores[res.userId].testsTaken += 1;
    });

    const sortedUsers = Object.values(userScores).sort((a, b) => b.totalScore - a.totalScore).slice(0, 10);

    if (sortedUsers.length === 0) {
        return ctx.answerCallbackQuery({ text: 'Hozircha reyting shakllanmagan.', show_alert: true });
    }

    let text = `🏆 <b>Eng Kuchli 10 Talik (Umumiy reyting)</b>\n\n`;
    
    sortedUsers.forEach((u, index) => {
        let medal = '';
        if (index === 0) medal = '🥇';
        else if (index === 1) medal = '🥈';
        else if (index === 2) medal = '🥉';
        else medal = '🏅';

        text += `${medal} <b>${u.name}</b> — ${u.totalScore} ball (${u.testsTaken} ta test)\n`;
    });

    const keyboard = new InlineKeyboard()
        .text('⬅️ Orqaga', 'start');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

module.exports = { showProfile, showLeaderboard };
