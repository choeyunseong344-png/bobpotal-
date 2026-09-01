const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ================= 회원가입 & 중복확인 =================

app.post('/api/check-duplicate', async (req, res) => {
    const { field, value } = req.body;
    if (!['username', 'nickname'].includes(field)) {
        return res.status(400).json({ error: '유효하지 않은 필드입니다.' });
    }
    const { data, error } = await supabase.from('users').select('id').eq(field, value).single();
    if (data) {
        return res.json({ available: false, message: `이미 사용 중인 ${field === 'username' ? '아이디' : '닉네임'}입니다.` });
    }
    return res.json({ available: true, message: `사용 가능한 ${field === 'username' ? '아이디' : '닉네임'}입니다.` });
});

app.post('/api/register', async (req, res) => {
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
    const { data, error } = await supabase
        .from('posts')
        .select(`*, seller:users!seller_id(id, nickname, school)`)
        .order('created_at', { ascending: false });
    
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

app.post('/api/posts', async (req, res) => {
    const { seller_id, title, content, price, meal_date } = req.body;
    const { data, error } = await supabase.from('posts').insert([{
        seller_id, title, content, price, meal_date, status: 'AVAILABLE'
    }]).select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

// ================= 1:1 채팅 & 1시간 제한 삭제 로직 =================

// 만료된 채팅(완료 후 1시간 경과) 자동 정리 함수
async function cleanupExpiredChats() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    
    // 완료된 지 1시간이 넘은 채팅 조회
    const { data: expiredChats } = await supabase
        .from('chats')
        .select('id')
        .eq('status', 'COMPLETED')
        .lt('completed_at', oneHourAgo);

    if (expiredChats && expiredChats.length > 0) {
        const chatIds = expiredChats.map(c => c.id);
        // 메시지 및 채팅방 삭제
        await supabase.from('messages').delete().in('chat_id', chatIds);
        await supabase.from('chats').delete().in('id', chatIds);
    }
}

app.post('/api/chat/start', async (req, res) => {
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

// 채팅 상세 및 메시지 조회 (학번 전달 & 1시간 만료 체크 포함)
app.get('/api/chat/:chatId', async (req, res) => {
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
        return res.status(404).json({ error: '채팅방이 존재하지 않거나 만료되어 삭제되었습니다.' });
    }

    // 만료 여부 재확인
    if (chat.status === 'COMPLETED' && chat.completed_at) {
        const completedTime = new Date(chat.completed_at).getTime();
        if (Date.now() - completedTime > 60 * 60 * 1000) {
            await supabase.from('messages').delete().eq('chat_id', chatId);
            await supabase.from('chats').delete().eq('id', chatId);
            return res.status(410).json({ error: '거래 완료 후 1시간이 지나 채팅방이 삭제되었습니다.' });
        }
    }

    const { data: messages } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: true });

    res.json({ chat, messages: messages || [] });
});

app.post('/api/chat/:chatId/message', async (req, res) => {
    const { chatId } = req.params;
    const { sender_id, content } = req.body;

    const { data, error } = await supabase.from('messages').insert([{
        chat_id: chatId, sender_id, content
    }]).select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

// 거래 완료 처리 (완료 시간 기록)
app.post('/api/chat/:chatId/complete', async (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`));
