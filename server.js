const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Supabase 설정 (Vercel 환경 변수 우선 적용, 없을 경우 안전하게 처리)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'placeholder';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 1. 서라벌고등학교 실시간 급식 메뉴 API (나이스 개방포털)
app.get('/api/meal', async (req, res) => {
    try {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        const ymd = `${year}${month}${day}`;

        // 서울시교육청(B10), 서라벌고등학교(7010185)
        const url = `https://open.neis.go.kr/hub/mealServiceDietInfo?Type=json&ATPT_OFCDC_SC_CODE=B10&SD_SCHUL_CODE=7010185&MLSV_YMD=${ymd}`;
        const response = await axios.get(url);
        const data = response.data;

        let lunch = '';
        let dinner = '';

        if (data.mealServiceDietInfo && data.mealServiceDietInfo[1]) {
            const rows = data.mealServiceDietInfo[1].row;
            rows.forEach(row => {
                const cleanMenu = row.DDISH_NM.replace(/<br\/>/g, ', ').replace(/\([0-9\.]+\)/g, '').trim();
                if (row.MMEAL_SC_CODE === '2') lunch = cleanMenu;
                if (row.MMEAL_SC_CODE === '3') dinner = cleanMenu;
            });
        }

        res.json({
            success: true,
            lunch: lunch || '오늘 점심 정보가 없습니다.',
            dinner: dinner || '오늘 저녁 정보가 없습니다.'
        });
    } catch (err) {
        res.status(500).json({ success: false, message: '급식 정보 조회 오류' });
    }
});

// 2. 아이디/닉네임 중복확인 API
app.post('/api/check-duplicate', async (req, res) => {
    const { field, value } = req.body;
    try {
        const { data, error } = await supabase
            .from('users')
            .select('id')
            .eq(field, value);

        if (error) throw error;

        if (data && data.length > 0) {
            return res.json({ available: false, message: `이미 사용 중인 ${field === 'username' ? '아이디' : '닉네임'}입니다.` });
        }
        res.json({ available: true, message: `사용 가능한 ${field === 'username' ? '아이디' : '닉네임'}입니다.` });
    } catch (err) {
        res.status(500).json({ available: false, message: 'DB 확인 오류' });
    }
});

// 3. 회원가입 API
app.post('/api/register', async (req, res) => {
    try {
        const { username, nickname, password, name, phone, school, student_id } = req.body;
        const { data, error } = await supabase
            .from('users')
            .insert([{ username, nickname, password, name, phone, school, student_id }]);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// 4. 로그인 API
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .eq('password', password)
            .single();

        if (error || !data) return res.status(401).json({ success: false, error: '아이디 또는 비밀번호가 일치하지 않습니다.' });
        res.json({ success: true, user: data });
    } catch (err) {
        res.status(500).json({ success: false, error: '로그인 오류' });
    }
});

// 5. 게시글 목록 조회 API
app.get('/api/posts', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('posts')
            .select('*, seller:users(nickname)')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json([]);
    }
});

// 6. 게시글 작성 API
app.post('/api/posts', async (req, res) => {
    try {
        const { seller_id, title, meal_date, price, content } = req.body;
        const { data, error } = await supabase
            .from('posts')
            .insert([{ seller_id, title, meal_date, price, content }]);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// SPA 라우팅 지원 (HTML 페이지 반환)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 로컬 테스트 환경에서만 app.listen 실행
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Vercel 서버리스 핸들러용 Export (필수)
module.exports = app;
