const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Supabase 환경 변수 체크 및 예외 처리
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabase = null;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
}

// ================= 회원가입 & 중복확인 =================

app.post('/api/check-duplicate', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase가 설정되지 않았습니다.' });
    const { field, value } = req.body;
    if (!['username', 'nickname'].includes(field)) {
        return res.status(400).json({ error: '유효하지 않은 필드입니다.' });
    }
    const { data } = await supabase.from('users').select('id').eq(field, value).single();
    if (data) {
        return res.json({ available: false, message: `이미 사용 중인 ${field === 'username' ? '아이디' : '닉네임'}입니다.` });
    }
    return res.json({ available: true, message: `사용 가능한 ${field === 'username' ? '아이디' : '닉네임'}입니다.` });
});

app.post('/api/register', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase가 설정되지 않았습니다.' });
    const { username, nickname, password, name, phone, school, student_id, days } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const { data, error } = await supabase.from('users').insert([{
            username,
            nickname,
            password: hashedPassword,
            name,
            phone,
            school,
            student_id,
            days: days || []
        }]).select().single();

        if (error) {
            if (error.code === '23505') {
                return res.status(400).json({ error: '아이디 또는 닉네임이 이미 존재합니다.' });
            }
            return res.status(400).json({ error: error.message });
        }

        res.json({ success: true, user: { id: data.id, username: data.username, nickname: data.nickname } });
    } catch (err) {
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

app.post('/api/login', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase가 설정되지 않았습니다.' });
    const { username, password } = req.body;
    const { data: user, error } = await supabase.from('users').select('*').eq('username', username).single();
    if (error || !user) return res.status(400).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

    res.json({
        success: true,
        user: {
            id: user.id,
            username: user.username,
            nickname: user.nickname,
            name: user.name,
            school: user.school,
            student_id: user.student_id
        }
    });
});

// ================= 게시글 (석식 양도) =================

app.get('/api/posts', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase가 설정되지 않았습니다.' });
    const { data, error } = await supabase
        .from('posts')
        .select(`*, seller:users!seller_id(id, nickname, school)`)
        .order('created_at', { ascending: false });
    
    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);
});

app.post('/api/posts', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase가 설정되지 않았습니다.' });
    const { seller_id, title, content, price, meal_date } = req.body;
    const { data, error } = await supabase.from('posts').insert([{
        seller_id, title, content, price, meal_date, status: 'AVAILABLE'
    }]).select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

// ================= 1:1 채팅 & 1시간 제한 삭제 =================

async function cleanupExpiredChats() {
    if (!supabase) return;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    
    const { data: expiredChats } = await supabase
        .from('chats')
        .select('id')
        .eq('status', 'COMPLETED')
        .lt('completed_at', oneHourAgo);

    if (expiredChats && expiredChats.length > 0) {
        const chatIds = expiredChats.map(c => c.id);
        await supabase.from('messages').delete().in('chat_id', chatIds);
        await supabase.from('chats').delete().in('id', chatIds);
    }
}

app.post('/api/chat/start', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase가 설정되지 않았습니다.' });
    await cleanupExpiredChats();
    const { post_id, buyer_id } = req.body;

    const { data: post } = await supabase.from('posts').select('*').eq('id', post_id).single();
    if (!post) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });

    let { data: chat } = await supabase
        .from('chats')
        .select('*')
        .eq('post_id', post_id)
        .eq('buyer_id', buyer_id)
        .single();

    if (!chat) {
        const { data: newChat, error } = await supabase.from('chats').insert([{
            post_id,
            seller_id: post.seller_id,
            buyer_id,
            status: 'ACTIVE'
        }]).select().single();
        if (error) return res.status(400).json({ error: error.message });
        chat = newChat;
    }

    res.json(chat);
});

app.get('/api/chat/:chatId', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase가 설정되지 않았습니다.' });
    await cleanupExpiredChats();
    const { chatId } = req.params;

    const { data: chat, error } = await supabase
        .from('chats')
        .select(`
            *,
            post:posts(*),
            seller:users!seller_id(id, nickname, student_id, name),
            buyer:users!buyer_id(id, nickname, student_id, name)
        `)
        .eq('id', chatId)
        .single();

    if (error || !chat) {
        return res.status(404).json({ error: '채팅방이 존재하지 않거나 만료되었습니다.' });
    }

    const { data: messages } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: true });

    res.json({ chat, messages: messages || [] });
});

app.post('/api/chat/:chatId/message', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase가 설정되지 않았습니다.' });
    const { chatId } = req.params;
    const { sender_id, content } = req.body;

    const { data, error } = await supabase.from('messages').insert([{
        chat_id: chatId, sender_id, content
    }]).select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

app.post('/api/chat/:chatId/complete', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase가 설정되지 않았습니다.' });
    const { chatId } = req.params;
    const now = new Date().toISOString();

    const { data: chat, error: chatErr } = await supabase
        .from('chats')
        .update({ status: 'COMPLETED', completed_at: now })
        .eq('id', chatId)
        .select('*, post_id')
        .single();

    if (chatErr) return res.status(400).json({ error: chatErr.message });

    await supabase.from('posts').update({ status: 'COMPLETED' }).eq('id', chat.post_id);

    res.json({ success: true, completed_at: now });
});

// Vercel Serverless 모듈 내보내기
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`));
}
