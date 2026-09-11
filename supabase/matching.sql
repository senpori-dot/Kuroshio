-- =============================================================================
-- R9 黒潮医療人養成プロジェクト 希望調整
-- 1次マッチング確定 / 2次マッチング のための最小追加スキーマ
--
-- 実行方法: Supabase ダッシュボードの SQL Editor に貼り付けて実行してください。
--           （このリポジトリはフロントエンドのみで、DDL を自動実行しません）
--
-- 既存の students / slots / app_settings / change_log / admins テーブルと、
-- 既存の student_snapshot / student_set_choice / is_admin 関数は変更しません。
-- RLS の無効化も、既存制約の削除も行いません。
--
-- 追加するもの:
--   1. テーブル match_rounds / match_results（RLS 有効・管理者は参照のみ）
--   2. 関数 run_first_matching() / finalize_first_matching()
--      （1次マッチング確定。冪等・原子的。締切を過ぎていれば学生画面を開いた
--        時点で自動確定します）
--   3. 関数 student_matching()（学生画面用。氏名以外の個人情報は返しません）
--   4. 関数 reset_test_matching()（テスト実行分のみ削除。本番結果は削除不可）
--   5. トリガー students_guard_after_first_matching（確定者の変更禁止・2次の空き枠制限）
--
-- 実際の型は稼働中のプロジェクトを確認して合わせています:
--   students.id / slots.id / students.current_slot_id は uuid
--   app_settings.deadline_on は date、daily_close は time、timezone は text
--   admins は user_id 列で auth.uid() と対応
-- このファイルは何度実行しても同じ状態になります（再実行可）。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 結果を保存するテーブル
-- -----------------------------------------------------------------------------

-- 1ラウンドにつき1行だけ。この主キーが「二重確定できない」ことの根拠です。
create table if not exists public.match_rounds (
  round        smallint    primary key,
  finalized_at timestamptz not null default now(),
  is_test      boolean     not null default false,
  deadline_on  date,
  daily_close  time,
  note         text
);

create table if not exists public.match_results (
  round        smallint    not null references public.match_rounds(round) on delete cascade,
  student_id   uuid        not null references public.students(id) on delete cascade,
  slot_id      uuid        references public.slots(id) on delete set null,
  outcome      text        not null check (outcome in ('confirmed', 'second_matching')),
  lottery_rank integer,
  created_at   timestamptz not null default now(),
  primary key (round, student_id)
);

-- 2次マッチングで確定した枠。1次の抽選記録 (slot_id / outcome / lottery_rank) は
-- 書き換えず、この列が入った時点で「2次マッチング待ちではない」と判定します。
alter table public.match_results
  add column if not exists second_slot_id     uuid references public.slots(id) on delete set null,
  add column if not exists second_assigned_at timestamptz;

create index if not exists match_results_round_slot_idx
  on public.match_results (round, slot_id);

alter table public.match_rounds  enable row level security;
alter table public.match_results enable row level security;

-- 管理者は参照のみ。INSERT / UPDATE / DELETE のポリシーは作りません。
-- 書き込みは下の security definer 関数だけが行えます（抽選結果の上書き防止）。
drop policy if exists match_rounds_admin_select on public.match_rounds;
create policy match_rounds_admin_select on public.match_rounds
  for select using (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists match_results_admin_select on public.match_results;
create policy match_results_admin_select on public.match_results
  for select using (exists (select 1 from public.admins a where a.user_id = auth.uid()));

grant select on public.match_rounds  to authenticated;
grant select on public.match_results to authenticated;

-- -----------------------------------------------------------------------------
-- 2. 1次マッチングの確定（冪等・原子的）
--
--    p_dry_run = true  … 抽選を計算して返すだけ。1行も保存しません（テスト用）
--    p_force   = true  … 締切前でも実行（Deploy Preview での検証用）
--    p_is_test = true  … テスト実行として記録し、reset_test_matching で消せる
--
--    戻り値の status:
--      finalized         … 今回確定した
--      already_finalized … 既に確定済みのため、保存済みの結果をそのまま返した
--      dry_run           … 計算のみ（未保存）
--      not_due           … 締切（deadline_on + daily_close, JST）に未到達
--      no_deadline       … deadline_on が未設定
-- -----------------------------------------------------------------------------
-- 抽選の本体。管理者チェックを持たないので、直接呼べないようにしてあります
-- （下の finalize_first_matching と student_matching からのみ呼ばれます）。
create or replace function public.run_first_matching(
  p_dry_run boolean default false,
  p_force   boolean default false,
  p_is_test boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round      smallint := 1;
  v_existing   public.match_rounds;
  v_deadline   date;
  v_close      time;
  v_tz         text;
  v_now_jst    timestamp;
  v_due        timestamp;
  v_status     text;
  v_results    jsonb;
  v_slots      jsonb;
begin
  -- 同時実行を直列化する。トランザクション終了で自動解放される。
  perform pg_advisory_xact_lock(hashtext('r9_match_round_' || v_round));

  select * into v_existing from public.match_rounds where round = v_round;

  if v_existing.round is not null then
    -- 既に確定済み: 抽選をやり直さず、保存済みの結果をそのまま返す
    v_status := 'already_finalized';
    select coalesce(jsonb_agg(jsonb_build_object(
             'student_id',    r.student_id,
             'student_name',  st.name,
             'slot_id',       r.slot_id,
             'slot_facility', sl.facility,
             'slot_label',    sl.label,
             'start_course',  sl.start_course,
             'end_course',    sl.end_course,
             'lottery_rank',  r.lottery_rank,
             'outcome',       r.outcome
           ) order by sl.sort_order nulls last, r.lottery_rank), '[]'::jsonb)
      into v_results
      from public.match_results r
      join public.students st on st.id = r.student_id
      left join public.slots sl on sl.id = r.slot_id
     where r.round = v_round;
  else
    -- 締切は保存されている最新の設定から毎回読み直す（日時のハードコードなし）
    select s.deadline_on, s.daily_close, nullif(btrim(coalesce(s.timezone, '')), '')
      into v_deadline, v_close, v_tz
      from public.app_settings s limit 1;
    -- 設定が空、または不正なタイムゾーン名のときは従来どおり Asia/Tokyo で判定する
    if v_tz is null or not exists (select 1 from pg_timezone_names z where z.name = v_tz) then
      v_tz := 'Asia/Tokyo';
    end if;
    v_now_jst := (now() at time zone v_tz);

    if v_deadline is null then
      if not p_force then
        return jsonb_build_object('status', 'no_deadline', 'round', v_round);
      end if;
    else
      v_due := v_deadline + coalesce(v_close, time '23:59:59');
      if v_now_jst < v_due and not p_force then
        return jsonb_build_object(
          'status', 'not_due', 'round', v_round,
          'due_at', to_char(v_due, 'YYYY-MM-DD HH24:MI'),
          'now_jst', to_char(v_now_jst, 'YYYY-MM-DD HH24:MI'),
          'timezone', v_tz
        );
      end if;
    end if;

    -- 抽選は1回だけ実行し、その結果 (v_results) をそのまま保存する。
    -- random() を二度呼ばないので、返した結果と保存した結果は必ず一致する。
    with applicants as (
      select st.id                as student_id,
             st.name              as student_name,
             st.current_slot_id   as slot_id,
             row_number() over (
               partition by st.current_slot_id order by random(), st.id
             )                    as lottery_rank
        from public.students st
       where st.current_slot_id is not null
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'student_id',    a.student_id,
             'student_name',  a.student_name,
             'slot_id',       a.slot_id,
             'slot_facility', sl.facility,
             'slot_label',    sl.label,
             'start_course',  sl.start_course,
             'end_course',    sl.end_course,
             'lottery_rank',  a.lottery_rank,
             'outcome',       case when a.lottery_rank <= coalesce(sl.capacity, 0)
                                   then 'confirmed' else 'second_matching' end
           ) order by sl.sort_order nulls last, a.lottery_rank), '[]'::jsonb)
      into v_results
      from applicants a
      join public.slots sl on sl.id = a.slot_id;

    if p_dry_run then
      v_status := 'dry_run';
    else
      insert into public.match_rounds (round, is_test, deadline_on, daily_close)
      values (v_round, p_is_test, v_deadline, v_close);

      insert into public.match_results (round, student_id, slot_id, outcome, lottery_rank)
      select v_round,
             (r->>'student_id')::uuid,
             (r->>'slot_id')::uuid,
             r->>'outcome',
             (r->>'lottery_rank')::int
        from jsonb_array_elements(v_results) r;

      select * into v_existing from public.match_rounds where round = v_round;
      v_status := 'finalized';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'slot_id',         sl.id,
           'facility',        sl.facility,
           'label',           sl.label,
           'start_course',    sl.start_course,
           'end_course',      sl.end_course,
           'capacity',        coalesce(sl.capacity, 0),
           'confirmed_count', c.n,
           'remaining',       greatest(coalesce(sl.capacity, 0) - c.n, 0)
         ) order by sl.sort_order nulls last), '[]'::jsonb)
    into v_slots
    from public.slots sl
    cross join lateral (
      select count(*)::int as n
        from jsonb_array_elements(v_results) r
       where r->>'slot_id' = sl.id::text
         and r->>'outcome' = 'confirmed'
    ) c
   where coalesce(sl.active, true);

  return jsonb_build_object(
    'status',       v_status,
    'round',        v_round,
    'finalized_at', v_existing.finalized_at,
    'is_test',      coalesce(v_existing.is_test, p_is_test),
    'results',      v_results,
    'slots',        v_slots
  );
end;
$$;

revoke all on function public.run_first_matching(boolean, boolean, boolean) from public;

-- 管理者が画面から実行する入口。抽選そのものは run_first_matching に委譲します。
create or replace function public.finalize_first_matching(
  p_dry_run boolean default false,
  p_force   boolean default false,
  p_is_test boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception '管理者のみ実行できます' using errcode = '42501';
  end if;
  return public.run_first_matching(p_dry_run, p_force, p_is_test);
end;
$$;

revoke all on function public.finalize_first_matching(boolean, boolean, boolean) from public;
grant execute on function public.finalize_first_matching(boolean, boolean, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. 学生画面用（個人URLのトークンで認証）
--    返すのは自分の結果と、枠ごとの「確定者の氏名」「残り定員」だけです。
--    access_token / student_code / メール / 他学生の id は一切返しません。
-- -----------------------------------------------------------------------------
create or replace function public.student_matching(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round   smallint := 1;
  v_student public.students;
  v_row     public.match_rounds;
  v_mine    public.match_results;
  v_slot    public.slots;
  v_slots   jsonb;
begin
  select * into v_student from public.students where access_token = p_token;
  if v_student.id is null then
    raise exception '個人URLが正しくありません' using errcode = 'P0001';
  end if;

  -- 締切（app_settings の deadline_on + daily_close、timezone で判定）を過ぎていれば、
  -- 学生画面が開かれた時点で自動的に1次マッチングを確定する。締切前なら
  -- run_first_matching が not_due を返すだけで何も保存しない。確定済みなら
  -- round の主キーとアドバイザリロックにより抽選はやり直されない。
  if not exists (select 1 from public.match_rounds where round = v_round) then
    perform public.run_first_matching(false, false, false);
  end if;

  select * into v_row from public.match_rounds where round = v_round;
  if v_row.round is null then
    return jsonb_build_object('finalized', false, 'round', v_round);
  end if;

  select * into v_mine
    from public.match_results
   where round = v_round and student_id = v_student.id;

  -- 2次マッチングで枠が決まっている学生は、その枠が最終確定先になる
  if coalesce(v_mine.second_slot_id, v_mine.slot_id) is not null then
    select * into v_slot from public.slots
     where id = coalesce(v_mine.second_slot_id, v_mine.slot_id);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'slot_id',         sl.id,
           'capacity',        coalesce(sl.capacity, 0),
           'confirmed_count', c.n,
           'remaining',       greatest(coalesce(sl.capacity, 0) - c.n, 0),
           'confirmed_names', coalesce(c.names, '[]'::jsonb)
         ) order by sl.sort_order nulls last), '[]'::jsonb)
    into v_slots
    from public.slots sl
    cross join lateral (
      select count(*)::int as n,
             jsonb_agg(st.name order by st.name) as names
        from public.match_results r
        join public.students st on st.id = r.student_id
       where r.round = v_round
         and (
           (r.outcome = 'confirmed' and r.slot_id = sl.id)
           or r.second_slot_id = sl.id
         )
    ) c;

  return jsonb_build_object(
    'finalized',        true,
    'round',            v_round,
    'finalized_at',     v_row.finalized_at,
    'is_test',          v_row.is_test,
    'my_outcome',       case when v_mine.second_slot_id is not null
                             then 'confirmed' else v_mine.outcome end,
    'my_slot_id',       coalesce(v_mine.second_slot_id, v_mine.slot_id),
    'my_round',         case when v_mine.second_slot_id is not null then 2 else 1 end,
    'my_lottery_rank',  v_mine.lottery_rank,
    'my_slot_facility', v_slot.facility,
    'my_slot_label',    v_slot.label,
    'my_start_course',  v_slot.start_course,
    'my_end_course',    v_slot.end_course,
    'slots',            v_slots
  );
end;
$$;

revoke all on function public.student_matching(text) from public;
grant execute on function public.student_matching(text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. テスト実行のみを消す（本番の確定結果は絶対に削除されません）
--    is_test = true のラウンドだけを削除します。
-- -----------------------------------------------------------------------------
create or replace function public.reset_test_matching(p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception '管理者のみ実行できます' using errcode = '42501';
  end if;
  if p_confirm is distinct from 'RESET-TEST' then
    raise exception '確認文字列が一致しません' using errcode = 'P0001';
  end if;

  delete from public.match_rounds where is_test;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('status', 'reset', 'deleted_rounds', v_deleted);
end;
$$;

revoke all on function public.reset_test_matching(text) from public;
grant execute on function public.reset_test_matching(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. 確定後の変更をサーバー側でも禁止する
--    ・1次マッチングで確定した学生は希望を変更できない
--    ・2次マッチングでは、1次確定後に空きのある枠しか選べない
--      （定員判定は枠単位のアドバイザリロックで直列化するので、最後の1席を
--        同時に選んでも1人しか成功しません）
--    ・管理者による調整は従来どおり可能
--    既存の student_set_choice 関数は変更せず、students の UPDATE を監視します。
--    外したい場合:
--      drop trigger if exists students_guard_after_first_matching on public.students;
-- -----------------------------------------------------------------------------
create or replace function public.guard_after_first_matching()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity int;
  v_taken    int;
begin
  if new.current_slot_id is not distinct from old.current_slot_id then
    return new;
  end if;
  if not exists (select 1 from public.match_rounds where round = 1) then
    return new;
  end if;
  if exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    return new;
  end if;

  if exists (
    select 1 from public.match_results r
     where r.round = 1 and r.student_id = old.id
       and (r.outcome = 'confirmed' or r.second_slot_id is not null)
  ) then
    raise exception 'マッチングで確定済みのため、希望を変更できません' using errcode = 'P0001';
  end if;

  if new.current_slot_id is not null then
    -- 同じ枠を狙う同時更新を直列化する。トランザクション終了で自動解放される。
    -- 既定の READ COMMITTED では、ロックを取得した後の count は直前にコミット
    -- された移動を必ず見るので、定員の確認とこの UPDATE が原子的になる。
    -- これが無いと、残り1席を2人が同時に選んで両方成功しうる。
    perform pg_advisory_xact_lock(hashtext('r9_slot_' || new.current_slot_id::text));

    select coalesce(capacity, 0) into v_capacity from public.slots where id = new.current_slot_id;

    -- 1次で確定した学生と、2次で既にこの枠へ移動した学生の両方を数える。
    -- 学生単位で1回だけ数えるので二重計上はしない。自分自身は除き、
    -- 「自分が入ったあとも定員以内か」を v_taken >= v_capacity で判定する。
    select count(*) into v_taken
      from public.students st
     where st.id <> old.id
       and (
         st.current_slot_id = new.current_slot_id
         or exists (
           select 1
             from public.match_results r
            where r.round = 1
              and r.student_id = st.id
              and (
                (r.outcome = 'confirmed' and r.slot_id = new.current_slot_id)
                or r.second_slot_id = new.current_slot_id
              )
         )
       );

    if v_taken >= v_capacity then
      raise exception '2次マッチングでは、空きのある枠のみ選択できます' using errcode = 'P0001';
    end if;

    -- 空きが取れたので、この枠を最終確定先として保存し、2次マッチング待ちを解除する。
    -- 1次の抽選記録 (slot_id / outcome / lottery_rank) はそのまま残す。
    -- 1次で希望を出していなかった学生には行が無いので、その場合は作成する。
    insert into public.match_results
      (round, student_id, slot_id, outcome, lottery_rank, second_slot_id, second_assigned_at)
    values
      (1, old.id, null, 'second_matching', null, new.current_slot_id, now())
    on conflict (round, student_id) do update
      set second_slot_id     = excluded.second_slot_id,
          second_assigned_at = excluded.second_assigned_at;
  end if;

  return new;
end;
$$;

drop trigger if exists students_guard_after_first_matching on public.students;
create trigger students_guard_after_first_matching
  before update of current_slot_id on public.students
  for each row execute function public.guard_after_first_matching();

notify pgrst, 'reload schema';
