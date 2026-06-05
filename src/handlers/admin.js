const { InlineKeyboard, InputFile } = require('grammy');
const { parseQuestions, exportResults } = require('../utils/excel_handler');
const prisma = require('../db');
const fs = require('fs');
const path = require('path');
const https = require('https');

async function showAdminPanel(ctx) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    ctx.session.step = 'idle';

    const totalUsers = await prisma.user.count();
    const totalQuestions = await prisma.question.count();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTests = await prisma.result.count({
        where: { createdAt: { gte: today } }
    });

    const text = `⚙️ <b>Admin Paneli</b>\n\n` +
                 `📊 <b>Tezkor Statistika:</b>\n` +
                 `Jami foydalanuvchilar: <b>${totalUsers}</b>\n` +
                 `Bazadagi jami savollar: <b>${totalQuestions}</b>\n` +
                 `Bugun ishlangan testlar: <b>${todayTests}</b>\n\n` +
                 `Kerakli amalni tanlang:`;

    const reportSetting = await prisma.setting.findUnique({ where: { key: 'showReport' } });
    const isReportOn = reportSetting ? reportSetting.value === 'true' : true;
    const reportBtnText = isReportOn ? '🟢 Hisobot: YOQILGAN' : '🔴 Hisobot: O\'CHIRILGAN';

    const keyboard = new InlineKeyboard()
        .text('📥 Savollarni yuklash', 'import_questions')
        .text('📤 Natijalarni olish', 'export_results')
        .row()
        .text('🗂 Testlarni boshqarish', 'manage_tests')
        .text('🖼 Savollarni tahrirlash', 'edit_questions')
        .row()
        .text('⏱ Vaqtlarni sozlash', 'timer_settings')
        .row()
        .text('📢 Xabarnoma yuborish', 'broadcast_msg')
        .row()
        .text(reportBtnText, 'toggle_report')
        .row()
        .text('⬅️ Orqaga', 'start');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function handleImportStart(ctx) {
    ctx.session.step = 'awaiting_excel';
    await ctx.editMessageText('Iltimos, test savollari bo\'lgan Excel faylni yuboring.\n\nFayl formati:\n1-ustun: Kategoriya\n2-ustun: Savol matni\n3-6 ustunlar: Variantlar\n7-ustun: To\'g\'ri javob matni');
}

async function handleExcelUpload(ctx) {
    if (ctx.session.step !== 'awaiting_excel') return;
    if (!ctx.message.document) return ctx.reply('Iltimos, fayl yuboring.');

    const doc = ctx.message.document;
    if (!doc.file_name.endsWith('.xlsx')) {
        return ctx.reply('Faqat .xlsx fayllar qabul qilinadi.');
    }

    if (doc.file_size > 5 * 1024 * 1024) {
        return ctx.reply('Fayl hajmi 5MB dan oshmasligi kerak.');
    }

    const file = await ctx.getFile();
    const uniqueFileName = `${Date.now()}_${doc.file_name}`;
    const filePath = path.join(__dirname, '../../tmp', uniqueFileName);
    
    // tmp papkasini tekshirish
    if (!fs.existsSync(path.join(__dirname, '../../tmp'))) {
        fs.mkdirSync(path.join(__dirname, '../../tmp'));
    }

    // Faylni yuklab olish
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    await new Promise((resolve, reject) => {
        const localFile = fs.createWriteStream(filePath);
        https.get(fileUrl, (response) => {
            response.pipe(localFile);
            localFile.on('finish', () => {
                localFile.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(filePath, () => reject(err));
        });
    });

    try {
        const questions = await parseQuestions(filePath);
        let importedCount = 0;

        for (const q of questions) {
            let category = await prisma.category.findUnique({ where: { name: q.category } });
            if (!category) {
                category = await prisma.category.create({ data: { name: q.category } });
            }

            const existingQuestion = await prisma.question.findFirst({
                where: {
                    text: q.text,
                    categoryId: category.id
                }
            });

            if (!existingQuestion) {
                await prisma.question.create({
                    data: {
                        text: q.text,
                        options: q.options,
                        correctAnswer: q.correctAnswer,
                        categoryId: category.id
                    }
                });
                importedCount++;
            }
        }

        const keyboard = new InlineKeyboard().text('⬅️ Admin paneliga qaytish', 'admin_panel');
        await ctx.reply(`Muvaffaqiyatli yakunlandi! ${importedCount} ta savol qo'shildi.\n\nBemalol keyingi Excel faylni ham yuklashingiz mumkin.`, { reply_markup: keyboard });
    } catch (error) {
        console.error(error);
        if (error.message.includes('Excel fayl formati noto\'g\'ri')) {
            await ctx.reply(error.message);
        } else {
            await ctx.reply('Faylni qayta ishlashda xatolik yuz berdi.');
        }
    } finally {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

async function handleExportResults(ctx) {
    const results = await prisma.result.findMany({
        include: { user: true },
        orderBy: { createdAt: 'desc' }
    });

    if (results.length === 0) {
        return ctx.answerCallbackQuery('Hozircha natijalar yo\'q.');
    }

    const buffer = await exportResults(results);
    const fileName = `results_${new Date().toISOString().split('T')[0]}.xlsx`;
    
    await ctx.replyWithDocument(new InputFile(buffer, fileName), { caption: 'Barcha test natijalari' });
}

async function showManageCategories(ctx) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    const categories = await prisma.category.findMany({
        include: { _count: { select: { questions: true } } }
    });

    if (categories.length === 0) {
        return ctx.answerCallbackQuery({ text: 'Hozircha hech qanday test mavjud emas.', show_alert: true });
    }

    const keyboard = new InlineKeyboard();
    categories.forEach(cat => {
        keyboard.text(`${cat.name} (${cat._count.questions})`, `manage_cat_${cat.id}`).row();
    });
    keyboard.text('⬅️ Orqaga', 'admin_panel');

    await ctx.editMessageText('Boshqarmoqchi bo\'lgan fanni tanlang:', { reply_markup: keyboard });
}

async function manageCategoryItem(ctx, categoryId) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    const category = await prisma.category.findUnique({
        where: { id: parseInt(categoryId) },
        include: { _count: { select: { questions: true } } }
    });

    if (!category) return ctx.answerCallbackQuery('Kategoriya topilmadi.');

    const keyboard = new InlineKeyboard()
        .text('🗑 Barcha savollarni tozalash', `clear_cat_${category.id}`).row()
        .text('❌ Kategoriyani butunlay o\'chirish', `del_cat_${category.id}`).row()
        .text('⬅️ Orqaga', 'manage_tests');

    await ctx.editMessageText(`Fan: ${category.name}\nSavollar soni: ${category._count.questions}\n\nQanday amal bajaramiz?`, { reply_markup: keyboard });
}

async function clearCategoryQuestions(ctx, categoryId) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    await prisma.question.deleteMany({
        where: { categoryId: parseInt(categoryId) }
    });

    await ctx.answerCallbackQuery({ text: 'Barcha savollar tozalandi!', show_alert: true });
    await manageCategoryItem(ctx, categoryId);
}

async function deleteCategory(ctx, categoryId) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    // Avval savollarni o'chiramiz (Foreign Key qoidasi)
    await prisma.question.deleteMany({
        where: { categoryId: parseInt(categoryId) }
    });

    // Keyin kategoriyani o'chiramiz
    await prisma.category.delete({
        where: { id: parseInt(categoryId) }
    });

    await ctx.answerCallbackQuery({ text: 'Kategoriya va uning savollari o\'chirildi!', show_alert: true });
    await showManageCategories(ctx);
}

async function toggleReportSetting(ctx) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    const reportSetting = await prisma.setting.findUnique({ where: { key: 'showReport' } });
    const isReportOn = reportSetting ? reportSetting.value === 'true' : true;

    await prisma.setting.upsert({
        where: { key: 'showReport' },
        update: { value: (!isReportOn).toString() },
        create: { key: 'showReport', value: (!isReportOn).toString() }
    });

    await ctx.answerCallbackQuery('Sozlama o\'zgartirildi!');
    await showAdminPanel(ctx);
}

async function handleBroadcastStart(ctx) {
    if (ctx.from.id != process.env.ADMIN_ID) return;
    ctx.session.step = 'awaiting_broadcast';
    await ctx.editMessageText('Iltimos, barcha foydalanuvchilarga yubormoqchi bo\'lgan xabaringizni yozing (yoki rasm/video yuboring):', {
        reply_markup: new InlineKeyboard().text('⬅️ Bekor qilish', 'admin_panel')
    });
}

async function handleBroadcastMessage(ctx) {
    if (ctx.session.step !== 'awaiting_broadcast' || ctx.from.id != process.env.ADMIN_ID) return;

    const users = await prisma.user.findMany({ select: { telegramId: true } });
    let successCount = 0;

    const msg = await ctx.reply(`Xabarnoma yuborilmoqda... (0/${users.length})`);

    for (let i = 0; i < users.length; i++) {
        try {
            await ctx.copyMessage(users[i].telegramId);
            successCount++;
        } catch (e) {
            // User blocked bot or something else
        }
        // Spam filtriga tushmaslik uchun ozgina kutish
        if (i % 20 === 0) await new Promise(r => setTimeout(r, 1000));
        if (i % 50 === 0) await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `Xabarnoma yuborilmoqda... (${i}/${users.length})`).catch(()=>{});
    }

    ctx.session.step = 'idle';
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `✅ Xabarnoma yuborildi!\nJami foydalanuvchilar: ${users.length}\nMuvaffaqiyatli bordi: ${successCount} kishiga.`, {
        reply_markup: new InlineKeyboard().text('⬅️ Admin paneliga qaytish', 'admin_panel')
    });
}

async function showTimerSettings(ctx) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    const qTime = await prisma.setting.findUnique({ where: { key: 'questionTime' } });
    const maxQ = await prisma.setting.findUnique({ where: { key: 'maxQuestions' } });

    const qLimit = qTime ? parseInt(qTime.value) : (process.env.QUESTION_TIME_LIMIT ? parseInt(process.env.QUESTION_TIME_LIMIT) : 30);
    const maxQLimit = maxQ ? parseInt(maxQ.value) : (process.env.MAX_QUESTIONS ? parseInt(process.env.MAX_QUESTIONS) : 30);

    const keyboard = new InlineKeyboard()
        .text(`Savol vaqti: ${qLimit} sek`, 'ignore')
        .row()
        .text('➖', 'timer_q_-5').text('➕', 'timer_q_+5')
        .row()
        .text(`Savollar soni: ${maxQLimit} ta`, 'ignore')
        .row()
        .text('➖', 'timer_limit_-5').text('➕', 'timer_limit_+5')
        .row()
        .text('⬅️ Orqaga', 'admin_panel');

    const text = `⚙️ <b>Test sozlamalari:</b>\n\n` +
                 `Quyidagi tugmalar orqali savol vaqtini va testdagi maksimal savollar sonini o'zgartirishingiz mumkin.\n\n` +
                 `💡 <i>Umumiy test vaqti savollar soniga qarab avtomatik hisoblanadi (Savollar soni × Savol vaqti). Masalan, ${maxQLimit} ta savoldan iborat test uchun umumiy vaqt ${Math.round((maxQLimit * qLimit) / 60)} daqiqa bo'ladi.</i>`;

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function handleTimerChange(ctx, type, amount) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    let key;
    let defaultVal;
    let minVal = 5;

    if (type === 'q') {
        key = 'questionTime';
        defaultVal = process.env.QUESTION_TIME_LIMIT ? parseInt(process.env.QUESTION_TIME_LIMIT) : 30;
    } else if (type === 'limit') {
        key = 'maxQuestions';
        defaultVal = process.env.MAX_QUESTIONS ? parseInt(process.env.MAX_QUESTIONS) : 30;
        minVal = 1;
    } else {
        key = 'quizTime';
        defaultVal = process.env.QUIZ_TIME_LIMIT ? parseInt(process.env.QUIZ_TIME_LIMIT) : 20;
    }

    const current = await prisma.setting.findUnique({ where: { key } });
    
    let newVal = current ? parseInt(current.value) : defaultVal;
    newVal += parseInt(amount);

    if (newVal < minVal) newVal = minVal;

    await prisma.setting.upsert({
        where: { key },
        update: { value: newVal.toString() },
        create: { key, value: newVal.toString() }
    });

    await showTimerSettings(ctx);
}

async function showEditCategories(ctx) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    const categories = await prisma.category.findMany({
        include: { _count: { select: { questions: true } } }
    });

    if (categories.length === 0) {
        return ctx.answerCallbackQuery({ text: 'Hozircha hech qanday test mavjud emas.', show_alert: true });
    }

    const keyboard = new InlineKeyboard();
    categories.forEach(cat => {
        keyboard.text(`${cat.name} (${cat._count.questions})`, `editq_cat_${cat.id}_0`).row();
    });
    keyboard.text('⬅️ Orqaga', 'admin_panel');

    await ctx.editMessageText('Savolini tahrirlamoqchi bo\'lgan fanni tanlang:', { reply_markup: keyboard });
}

async function showCategoryQuestions(ctx, categoryId, page = 0) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    const perPage = 10;
    const questions = await prisma.question.findMany({
        where: { categoryId: parseInt(categoryId) },
        skip: page * perPage,
        take: perPage,
        orderBy: { id: 'asc' }
    });
    
    const totalCount = await prisma.question.count({
        where: { categoryId: parseInt(categoryId) }
    });

    if (questions.length === 0) {
        return ctx.answerCallbackQuery({ text: 'Bu fanda savollar yo\'q.', show_alert: true });
    }

    const keyboard = new InlineKeyboard();
    questions.forEach((q, index) => {
        const hasImage = q.imageFileId ? '🖼 ' : '';
        const textPreview = q.text.length > 20 ? q.text.substring(0, 20) + '...' : q.text;
        keyboard.text(`${hasImage}${page * perPage + index + 1}. ${textPreview}`, `edit_q_${q.id}`).row();
    });

    const navRow = [];
    if (page > 0) {
        navRow.push(InlineKeyboard.text('⬅️ Oldingi', `editq_cat_${categoryId}_${page - 1}`));
    }
    if ((page + 1) * perPage < totalCount) {
        navRow.push(InlineKeyboard.text('Keyingi ➡️', `editq_cat_${categoryId}_${page + 1}`));
    }
    if (navRow.length > 0) keyboard.row(...navRow);

    keyboard.row().text('⬅️ Fanga qaytish', 'edit_questions');

    const messageText = `Fandagi savollar ro'yxati (${page * perPage + 1} - ${Math.min((page + 1) * perPage, totalCount)} / ${totalCount}):\nRasmi bor savollarda 🖼 belgisi turadi. Qaysi savolga rasm qo'shmoqchisiz?`;
    
    try {
        await ctx.editMessageText(messageText, { reply_markup: keyboard });
    } catch(e) {}
}

async function promptQuestionImage(ctx, questionId) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    const question = await prisma.question.findUnique({
        where: { id: parseInt(questionId) }
    });

    if (!question) return ctx.answerCallbackQuery('Savol topilmadi.');

    ctx.session.step = 'awaiting_q_image';
    ctx.session.edit_q_id = parseInt(questionId);

    const keyboard = new InlineKeyboard()
        .text('❌ Rasmni o\'chirish', `del_q_image_${question.id}`)
        .row()
        .text('⬅️ Bekor qilish', `editq_cat_${question.categoryId}_0`);

    let text = `<b>Tanlangan savol:</b>\n${question.text}\n\n`;
    if (question.imageFileId) {
        text += `<i>Hozirda bu savolda rasm mavjud. Yangi rasm yuborib uni almashtirishingiz mumkin.</i>`;
    } else {
        text += `<i>Iltimos, ushbu savol uchun rasmni botga yuboring.</i>`;
    }

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function handleQuestionImage(ctx) {
    if (ctx.session.step !== 'awaiting_q_image' || ctx.from.id != process.env.ADMIN_ID) return;
    
    if (!ctx.message.photo) {
        return ctx.reply('Iltimos, faqat rasm yuboring.');
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get highest resolution
    const questionId = ctx.session.edit_q_id;

    if (!questionId) return ctx.reply('Xatolik: Savol ID topilmadi.');

    const question = await prisma.question.update({
        where: { id: questionId },
        data: { imageFileId: photo.file_id }
    });

    ctx.session.step = 'idle';
    ctx.session.edit_q_id = null;

    const keyboard = new InlineKeyboard().text('⬅️ Savollar ro\'yxatiga qaytish', `editq_cat_${question.categoryId}_0`);
    await ctx.reply('✅ Savolga rasm muvaffaqiyatli biriktirildi!', { reply_markup: keyboard });
}

async function deleteQuestionImage(ctx, questionId) {
    if (ctx.from.id != process.env.ADMIN_ID) return;

    const question = await prisma.question.update({
        where: { id: parseInt(questionId) },
        data: { imageFileId: null }
    });

    ctx.session.step = 'idle';
    ctx.session.edit_q_id = null;

    const keyboard = new InlineKeyboard().text('⬅️ Savollar ro\'yxatiga qaytish', `editq_cat_${question.categoryId}_0`);
    await ctx.editMessageText('✅ Savoldagi rasm o\'chirildi!', { reply_markup: keyboard });
}

module.exports = { 
    showAdminPanel, 
    handleImportStart, 
    handleExcelUpload, 
    handleExportResults,
    showManageCategories,
    manageCategoryItem,
    clearCategoryQuestions,
    deleteCategory,
    toggleReportSetting,
    handleBroadcastStart,
    handleBroadcastMessage,
    showTimerSettings,
    handleTimerChange,
    showEditCategories,
    showCategoryQuestions,
    promptQuestionImage,
    handleQuestionImage,
    deleteQuestionImage
};
