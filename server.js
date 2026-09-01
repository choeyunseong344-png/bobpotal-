const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase 환경변수 연결
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 1. 아이디 중복 확인 API
app.post('/api/check-username', async (req, res) => {
  const { username } = req.body;
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('username', username);

  if (error) return res.status(500).json({ success: false, message: 'DB 오류' });
  if (data && data.length > 0) {
    return res.json({ available: false, message: '이미 사용 중인 아이디입니다.' });
  }
  return res.json({ available: true, message: '사용 가능한 아이디입니다.' });
});

// 2. 닉네임 중복 확인 API
app.post('/api/check-nickname', async (req, res) => {
  const { nickname } = req.body;
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('nickname', nickname);

  if (error) return res.status(500).json({ success: false, message: 'DB 오류' });
  if (data && data.length > 0) {
    return res.json({ available: false, message: '이미 사용 중인 닉네임입니다.' });
  }
  return res.json({ available: true, message: '사용 가능한 닉네임입니다.' });
});

// 3. 회원가입 API (아이디/닉네임만 유일성 체크, 학교 및 기타 정보는 중복 허용)
app.post('/api/register', async (req, res) => {
  const { username, nickname, password, name, phone, school, student_id, dinner_days, terms_agreed } = req.body;

  // 아이디/닉네임 최종 중복 재검사
  const { data: existingUser } = await supabase
    .from('users')
    .select('username, nickname')
    .or(`username.eq.${username},nickname.eq.${nickname}`);

  if (existingUser && existingUser.length > 0) {
    return res.status(400).json({ success: false, message: '회원가입 실패 (중복된 아이디 또는 닉네임 존재)' });
  }

  const { data, error } = await supabase.from('users').insert([
    {
      username,
      nickname,
      password,
      name,
      phone,
      school,
      student_id,
      dinner_days,
      terms_agreed
    }
  ]).select();

  if (error) {
    return res.status(500).json({ success: false, message: '회원가입 중 오류가 발생했습니다.' });
  }

  return res.json({ success: true, user: data[0] });
});

// 4. 로그인 API
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .eq('password', password)
    .single();

  if (error || !data) {
    return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' });
  }

  return res.json({ success: true, user: data });
});

// 5. 게시글 목록 조회
app.get('/api/posts', async (req, res) => {
  const { data, error } = await supabase
    .from('posts')
    .select('*, users(nickname, school)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ success: false });
  return res.json({ success: true, posts: data });
});

// 6. 게시글 작성
app.post('/api/posts', async (req, res) => {
  const { seller_id, day_of_week, description } = req.body;

  const { data, error } = await supabase
    .from('posts')
    .insert([{ seller_id, day_of_week, description }])
    .select();

  if (error) return res.status(500).json({ success: false, message: '글 작성 실패' });
  return res.json({ success: true, post: data[0] });
});

// 7. 거래 시작 (채팅방 생성 또는 기존 방 조회)
app.post('/api/chat/start', async (req, res) => {
  const { post_id, seller_id, buyer_id } = req.body;

  let { data: room } = await supabase
    .from('chat_rooms')
    .select('*')
    .eq('post_id', post_id)
    .eq('buyer_id', buyer_id)
    .single();

  if (!room) {
    const { data: newRoom, error } = await supabase
      .from('chat_rooms')
      .insert([{ post_id, seller_id, buyer_id }])
      .select()
      .single();
    if (error) return res.status(500).json({ success: false });
    room = newRoom;
  }

  return res.json({ success: true, room });
});

// 8. 메시지 전송
app.post('/api/chat/message', async (req, res) => {
  const { room_id, sender_nickname, message } = req.body;
  const { data, error } = await supabase
    .from('chat_messages')
    .insert([{ room_id, sender_nickname, message }])
    .select();

  if (error) return res.status(500).json({ success: false });
  return res.json({ success: true, message: data[0] });
});

// 9. 메시지 조회 (폴링 방식)
app.get('/api/chat/messages/:room_id', async (req, res) => {
  const { room_id } = req.params;
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('room_id', room_id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ success: false });
  return res.json({ success: true, messages: data });
});

// 10. 거래 완료 및 학번/이름 자동 공개
app.post('/api/chat/complete', async (req, res) => {
  const { room_id } = req.body;

  // 거래 상태 업데이트
  await supabase.from('chat_rooms').update({ is_completed: true }).eq('id', room_id);

  // 채팅방 정보 및 판매자 정보 조회
  const { data: room } = await supabase.from('chat_rooms').select('*, posts(*)').eq('id', room_id).single();
  const { data: seller } = await supabase.from('users').select('name, student_id, phone').eq('id', room.seller_id).single();

  return res.json({
    success: true,
    seller_info: {
      name: seller.name,
      student_id: seller.student_id,
      phone: seller.phone
    }
  });
});

module.exports = app;
