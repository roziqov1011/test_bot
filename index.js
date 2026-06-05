const { Bot, session } = require('grammy');
const prisma = require('./src/db');
require('dotenv').config();
const { handleStart } = require('./src/handlers/start');
const { showCategories, startQuiz, handleAnswer } = require('./src/handlers/quiz');
const { showAdminPanel, handleImportStart, handleExcelUpload, handleExportResults, showManageCategories, manageCategoryItem, clearCategoryQuestions, deleteCategory, toggleReportSetting, handleBroadcastStart, handleBroadcastMessage, showTimerSettings, handleTimerChange, showEditCategories, showCategoryQuestions, promptQuestionImage, handleQuestionImage, deleteQuestionImage } = require('./src/handlers/admin');
const { showProfile, showLeaderboard } = require('./src/handlers/user');
const { PrismaAdapter } = require('@grammyjs/storage-prisma');
const { limit } = require('@grammyjs/ratelimiter');

if (!process.env.BOT_TOKEN) {
    console.error('XATOLIK: .env faylida BOT_TOKEN topilmadi!');
    process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

// Sessiyani sozlash
bot.use(session({
    initial: () => ({
        step: 'idle',
        quiz: null,
    }),
    storage: new PrismaAdapter(prisma.session),
}));

// Middlewares
bot.use(limit());

bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    
    let user = await prisma.user.findUnique({
        where: { telegramId: BigInt(ctx.from.id) }
    });

    if (!user) {
        user = await prisma.user.create({
            data: {
                telegramId: BigInt(ctx.from.id),
                username: ctx.from.username,
                firstName: ctx.from.first_name,
            }
        });
    }

    ctx.dbUser = user;
    return next();
});

// Commands
bot.command('start', handleStart);

// Callback Queries
bot.callbackQuery('start_quiz', showCategories);
bot.callbackQuery('admin_panel', showAdminPanel);
bot.callbackQuery('import_questions', handleImportStart);
bot.callbackQuery('export_results', handleExportResults);
bot.callbackQuery('start', handleStart);
bot.callbackQuery('manage_tests', showManageCategories);
bot.callbackQuery('edit_questions', showEditCategories);
bot.callbackQuery('toggle_report', toggleReportSetting);

bot.callbackQuery('my_profile', showProfile);
bot.callbackQuery('leaderboard', showLeaderboard);

bot.callbackQuery('broadcast_msg', handleBroadcastStart);
bot.callbackQuery('timer_settings', showTimerSettings);
bot.callbackQuery(/^timer_(q|qz|limit)_([+-]\d+)$/, async (ctx) => {
    const type = ctx.match[1];
    const amount = ctx.match[2];
    await handleTimerChange(ctx, type, amount);
});

bot.callbackQuery(/^select_cat_(\d+)$/, async (ctx) => {
    const categoryId = ctx.match[1];
    await startQuiz(ctx, categoryId);
});

bot.callbackQuery(/^answer_(\d+)$/, async (ctx) => {
    const answerIndex = parseInt(ctx.match[1]);
    await handleAnswer(ctx, answerIndex);
});

bot.callbackQuery(/^manage_cat_(\d+)$/, async (ctx) => {
    const categoryId = ctx.match[1];
    await manageCategoryItem(ctx, categoryId);
});

bot.callbackQuery(/^clear_cat_(\d+)$/, async (ctx) => {
    const categoryId = ctx.match[1];
    await clearCategoryQuestions(ctx, categoryId);
});

bot.callbackQuery(/^del_cat_(\d+)$/, async (ctx) => {
    const categoryId = ctx.match[1];
    await deleteCategory(ctx, categoryId);
});

bot.callbackQuery(/^editq_cat_(\d+)_(\d+)$/, async (ctx) => {
    const categoryId = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    await showCategoryQuestions(ctx, categoryId, page);
});

bot.callbackQuery(/^edit_q_(\d+)$/, async (ctx) => {
    const questionId = ctx.match[1];
    await promptQuestionImage(ctx, questionId);
});

bot.callbackQuery(/^del_q_image_(\d+)$/, async (ctx) => {
    const questionId = ctx.match[1];
    await deleteQuestionImage(ctx, questionId);
});

// Messages
bot.on('message:document', handleExcelUpload);

bot.on('message', async (ctx) => {
    if (ctx.session.step === 'awaiting_broadcast' && ctx.from.id == process.env.ADMIN_ID) {
        return handleBroadcastMessage(ctx);
    }
    if (ctx.session.step === 'awaiting_q_image' && ctx.from.id == process.env.ADMIN_ID) {
        if (ctx.message.photo) {
            return handleQuestionImage(ctx);
        } else {
            return ctx.reply('Iltimos, faqat rasm yuboring. Matn yoki boshqa fayl qabul qilinmaydi.');
        }
    }
});

// Inline Queries (Natijani ulashish)
bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;
    if (query.startsWith('result_')) {
        const resultId = parseInt(query.split('_')[1]);
        const result = await prisma.result.findUnique({
            where: { id: resultId },
            include: { user: true }
        });

        if (result) {
            await ctx.answerInlineQuery([
                {
                    type: 'article',
                    id: `res_${result.id}`,
                    title: 'Test Natijasi',
                    description: `${result.user.firstName}: ${result.score}/${result.totalQuestions}`,
                    input_message_content: {
                        message_text: `🚀 Men test topshirdim!\n\n👤 Foydalanuvchi: ${result.user.firstName}\n✅ Natija: ${result.score}/${result.totalQuestions}\n⏱ Vaqt: ${result.spentTime} sekund\n\nSiz ham o'zingizni sinab ko'ring! @${ctx.me.username}`,
                    }
                }
            ]);
        }
    }
});

// Xatoliklarni ushlash
bot.catch((err) => {
    console.error('Bot error:', err);
});

bot.start();
console.log('Bot muvaffaqiyatli ishga tushdi...');
