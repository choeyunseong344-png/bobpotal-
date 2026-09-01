const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabase = null;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
}

app.post('/api/check-duplicate', async (req, res) => {
    if (!supabase) return res.status(500).json({ available: false, message: 'Supabase 미설정' });
    const { field, value } = req.body;
    
    if (!['username', 'nickname'].includes(field)) {
        return res.status(400).json({ available: false, message: '유효하지 않은 항목입니다.' });
    }

    try {
        const { data, error } = await supabase
            .from('users')
            .select('id')
            .eq(field, value);

        if (error) {
            return res.status(400).json({ available: false, message: '중복 확인 실패' });
        }

        if (data && data.length > 0) {
            return res.json({ available: false, message: `이미 사용 중인 ${field === 'username' ? '아이디' : '닉네임'}입니다.` });
        }

        return res.json({ available: true, message: `사용 가능한 ${field === 'username' ? '아이디' : '닉네임'}입니다.` });
    } catch (err) {
        return res.status(500).json({ available: false, message: '서버 에러' });
    }
});

app.post('/api/register', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase 미설정' });
    const { username, nickname, password, name, phone, school, student_id } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const { data, error } = await supabase.from('users').insert([{
            username,
            nickname,
            password: hashedPassword,
            name,
            phone,
            school: school || '서라벌고등학교',
            student_id
        }]).select().single();

        if (error) {
            if (error.code === '23505') {
                return res.status(400).json({ error: '이미 존재하는 아이디 또는 닉네임입니다.' });
            }
            return res.status(400).json({ error: error.message });
        }

        res.json({ success: true, user: { id: data.id, username: data.username, nickname: data.nickname } });
    } catch (err) {
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

app.post('/api/login', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase 미설정' });
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

app.get('/api/posts', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase 미설정' });
    const { data, error } = await supabase
        .from('posts')
        .select(`*, seller:users!seller_id(id, nickname, school)`)
        .order('created_at', { ascending: false });
    
    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);
});

app.post('/api/posts', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase 미설정' });
    const { seller_id, title, content, price, meal_date } = req.body;
    const { data, error } = await supabase.from('posts').insert([{
        seller_id, title, content, price, meal_date, status: 'AVAILABLE'
    }]).select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`서버 포트: ${PORT}`));
}
