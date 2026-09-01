const express = require('express');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase 무료 DB 연동 (Vercel Environment Variables에서 불러옴)
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_ANON_KEY';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 1. 아이디 중복 확인
app.get('/api/check-username', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: '아이디를 입력해주세요.' });

  const { data } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
  if (data) return res.status(400).json({ error: '이미 사용중인 아이디입니다.' });
  res.json({ message: '사용 가능한 아이디입니다.' });
});

// 2. 닉네임 중복 확인
app.get('/api/check-nickname', async (req, res) => {
  const { nickname } = req.query;
  if (!nickname) return res.status(400).json({ error: '닉네임을 입력해주세요.' });

  const { data } = await supabase.from('users').select('id').eq('nickname', nickname).maybeSingle();
  if (data) return res.status(400).json({ error: '이미 사용중인 닉네임입니다.' });
  res.json({ message: '사용 가능한 닉네임입니다.' });
});

// 3. 회원가입 (약관동의, 요일선택, 비밀번호 재확인 검증)
app.post('/api/register', async (req, res) => {
  const { username, nickname, password, passwordConfirm, name, phone, school, studentId, dinnerDays, termsAgreed } = req.body;

  if (!username || !nickname || !password || !passwordConfirm || !name || !phone || !school || !studentId) {
    return res.status(400).json({ error: '모든 항목을 입력해야 회원가입이 가능합니다.' });
  }
  if (!termsAgreed) {
    return res.status(400).json({ error: '이용약관 및 개인정보 처리방침에 동의해야 합니다.' });
  }
  if (password !== passwordConfirm) {
    return res.status(400).json({ error: '비밀번호 재확인이 일치하지 않습니다.' });
  }
  if (!dinnerDays || dinnerDays.length === 0) {
    return res.status(400).json({ error: '석식을 신청한 요일을 하나 이상 선택해주세요.' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const { error } = await supabase.from('users').insert([{
    username,
    nickname,
    password: hashedPassword,
    name,
    phone,
    school,
    student_id: studentId,
    dinner_days: dinnerDays,
    terms_agreed: termsAgreed
  }]);

  if (error) return res.status(500).json({ error: '회원가입 실패 (중복된 정보 확인)' });
  res.json({ success: true, message: '회원가입이 완료되었습니다.' });
});

// 4. 로그인
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 모두 입력하세요.' });

  const { data: user } = await supabase.from('users').select('*').eq('username', username).maybeSingle();
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      studentId: user.student_id,
      dinnerDays: user.dinner_days
    }
  });
});

// 5. 판매글 올리기 (요건: 본인 석식 날짜 + 하루 1회 한도)
app.post('/api/posts', async (req, res) => {
  const { sellerId, dayOfWeek, description } = req.body;

  const { data: user } = await supabase.from('users').select('*').eq('id', sellerId).single();
  if (!user) return res.status(404).json({ error: '사용자 정보를 찾을 수 없습니다.' });

  // 석식 신청 요일 검증
  if (!user.dinner_days.includes(dayOfWeek)) {
    return res.status(403).json({ error: `신청하신 석식 요일(${user.dinner_days.join(', ')})에만 글을 올릴 수 있습니다.` });
  }

  // 하루 1회 게시글 한도 검증
  const today = new Date().toISOString().split('T')[0];
  const { data: existingPost } = await supabase.from('posts')
    .select('id').eq('seller_id', sellerId).gte('created_at', `${today}T00:00:00`).maybeSingle();

  if (existingPost) {
    return res.status(400).json({ error: '하루에 한 번만 판매글을 올릴 수 있습니다.' });
  }

  const { error } = await supabase.from('posts').insert([{
    seller_id: sellerId,
    day_of_week: dayOfWeek,
    description
  }]);

  if (error) return res.status(500).json({ error: '게시글 등록 중 오류가 발생했습니다.' });
  res.json({ success: true });
});

// 6. 판매글 목록 (닉네임만 표시)
app.get('/api/posts', async (req, res) => {
  const { data, error } = await supabase.from('posts').select(`
    id, day_of_week, description, created_at,
    users ( id, nickname )
  `).order('created_at', { ascending: false });

  if (error) return res.json([]);
  
  const formatted = data.map(p => ({
    id: p.id,
    sellerId: p.users.id,
    sellerNickname: p.users.nickname,
    dayOfWeek: p.day_of_week,
    description: p.description
  }));

  res.json(formatted);
});

// 7. 구매 요청 (1대1 채팅방 생성)
app.post('/api/trade-request', async (req, res) => {
  const { postId, buyerId } = req.body;

  const { data: post } = await supabase.from('posts').select('seller_id').eq('id', postId).single();
  if (!post) return res.status(404).json({ error: '게시글이 존재하지 않습니다.' });
  if (post.seller_id === buyerId) return res.status(400).json({ error: '본인 게시글에는 요청할 수 없습니다.' });

  // 기존 채팅방 확인 또는 생성
  let { data: room } = await supabase.from('chat_rooms')
    .select('id').eq('post_id', postId).eq('buyer_id', buyerId).maybeSingle();

  if (!room) {
    const { data: newRoom } = await supabase.from('chat_rooms').insert([{
      post_id: postId, seller_id: post.seller_id, buyer_id: buyerId
    }]).select().single();
    room = newRoom;
  }

  res.json({ roomId: room.id });
});

// 8. 1대1 채팅 메시지 조회 (3초 간격 폴링)
app.get('/api/chat/messages', async (req, res) => {
  const { roomId } = req.query;
  
  const { data: messages } = await supabase.from('chat_messages').select('*').eq('room_id', roomId).order('created_at', { ascending: true });
  const { data: room } = await supabase.from('chat_rooms').select('is_completed').eq('id', roomId).single();

  res.json({ messages: messages || [], isCompleted: room ? room.is_completed : false });
});

// 9. 채팅 메시지 전송
app.post('/api/chat/messages', async (req, res) => {
  const { roomId, senderNickname, message } = req.body;
  await supabase.from('chat_messages').insert([{ room_id: roomId, sender_nickname: senderNickname, message }]);
  res.json({ success: true });
});

// 10. 거래 완료 처리 (판매자 학번을 구매자 단독 알림으로 발송)
app.post('/api/chat/complete', async (req, res) => {
  const { roomId, sellerId } = req.body;

  const { data: room } = await supabase.from('chat_rooms').select('*').eq('id', roomId).single();
  if (!room || room.seller_id !== sellerId) {
    return res.status(403).json({ error: '판매자만 거래를 완료할 수 있습니다.' });
  }

  // 거래 완료 상태 변경
  await supabase.from('chat_rooms').update({ is_completed: true }).eq('id', roomId);

  // 판매자의 학번 조회
  const { data: seller } = await supabase.from('users').select('student_id').eq('id', sellerId).single();

  // 시스템 알림 메시지 삽입 (해당 채팅방에만 표시)
  await supabase.from('chat_messages').insert([{
    room_id: roomId,
    sender_nickname: '[시스템 알림]',
    message: `🎉 거래가 완료되었습니다! 판매자의 학번은 [${seller.student_id}] 입니다. 급식실에서 이용하세요.`
  }]);

  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));