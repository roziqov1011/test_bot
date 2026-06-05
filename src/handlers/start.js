const { InlineKeyboard } = require('grammy');
const { clearUserTimers } = require('./quiz');

async function handleStart(ctx) {
    const userId = ctx.from.id;
    clearUserTimers(userId);

    // Reset session step and quiz to prevent invalid state
    ctx.session.step = 'idle';
    ctx.session.quiz = null;

    const isAdmin = userId == process.env.ADMIN_ID;
    
    let welcomeText = `Assalomu alaykum, ${ctx.from.first_name}! \nTest botimizga xush kelibsiz. \n\nBilimingizni sinab ko'rish uchun "Testni boshlash" tugmasini bosing.`;
    
    const keyboard = new InlineKeyboard()
        .text('🚀 Testni boshlash', 'start_quiz')
        .row()
        .text('👤 Mening Profilim', 'my_profile')
        .text('🏆 Reyting', 'leaderboard')
        .row();

    if (isAdmin) {
        keyboard.text('⚙️ Admin Panel', 'admin_panel');
        welcomeText += `\n\nSiz adminsiz! Admin paneliga o'tishingiz mumkin.`;
    }

    await ctx.reply(welcomeText, { reply_markup: keyboard });
}

module.exports = { handleStart };
