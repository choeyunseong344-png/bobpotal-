const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Supabase 클라이언트 생성
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'placeholder';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 1. 서라벌고등학교 실시간 급식 메뉴 API
app.get('/api/meal', async (req, res) => {
    try {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        const ymd = `${year}${month}${day}`;

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

// 2. 아이디/닉네임 중복확인 API (500 에러 방지 처리)
app.post('/api/check-duplicate', async (req, res) => {
    const { field, value } = req.body;
    
    // 유효성 검사
    if (!field || !value) {
        return res.status(400).json({ available: false, message: '검색 필드와 값이 필요합니다.' });
    }

    try {
        const { data, error } = await supabase
            .from('users')
            .select('id')
            .eq(field, value);

        if (error) {
            console.error('Check Duplicate Supabase Error:', error.message);
            // DB 컬럼이 없거나 RLS 오류 시 500 대신 안내 메시지 반환
            return res.json({ available: false, message: `DB 확인 중 오류가 발생했습니다: ${error.message}` });
        }

        if (data && data.length > 0) {
            return res.json({ available: false, message: `이미 사용 중인 ${field === 'username' ? '아이디' : '닉네임'}입니다.` });
        }

        return res.json({ available: true, message: `사용 가능한 ${field === 'username' ? '아이디' : '닉네임'}입니다.` });
    } catch (err) {
        console.error('Check Duplicate Server Error:', err);
        return res.json({ available: false, message: '서버 내부 처리 오류가 발생했습니다.' });
    }
});

// 3. 회원가입 API
app.post('/api/register', async (req, res) => {
    try {
        const { username, nickname, password, name, phone, school, student_id } = req.body;
        const { data, error } = await supabase
            .from('users')
            .insert([{ username, nickname, password, name, phone, school, student_id }]);

        if (error) {
            console.error('Register Error:', error.message);
            return res.status(400).json({ success: false, error: error.message });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. 로그인 API (401 오류 원인 방지 및 예외 처리)
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ success: false, error: '아이디와 비밀번호를 모두 입력해주세요.' });
        }

        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .eq('password', password)
            .maybeSingle(); // single() 대신 maybeSingle() 사용으로 0건 조회 시 Crash 방지

        if (error || !data) {
            return res.status(401).json({ success: false, error: '아이디 또는 비밀번호가 일치하지 않습니다.' });
        }
        
        res.json({ success: true, user: data });
    } catch (err) {
        res.status(500).json({ success: false, error: '로그인 처리 중 오류가 발생했습니다.' });
    }
});

// 5. 게시글 목록 조회 API
app.get('/api/posts', async (req, res) => {
    try {
        let { data, error } = await supabase
            .from('posts')
            .select('*, seller:users(nickname)')
            .order('created_at', { ascending: false });

        if (error) {
            console.warn('릴레이션 조회 실패, 단일 조회를 시도합니다:', error.message);
            const fallback = await supabase
                .from('posts')
                .select('*')
                .order('created_at', { ascending: false });
            
            if (fallback.error) throw fallback.error;
            data = fallback.data;
        }

        res.json(data || []);
    } catch (err) {
        console.error('Posts Fetch Error:', err.message);
        res.status(200).json([]);
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

// SPA 라우팅 지원
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 로컬 테스트용
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
