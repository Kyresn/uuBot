import { describe, expect, it } from 'vitest';
import { mapNotice } from '../../plugins/channels/qq/notice.js';

const SELF_ID = 100;
const GROUP_ID = 123;

function notice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_type: 'notice',
    notice_type: 'group_ban',
    sub_type: 'ban',
    self_id: SELF_ID,
    group_id: GROUP_ID,
    user_id: SELF_ID,
    operator_id: 999,
    ...overrides,
  };
}

describe('mapNotice', () => {
  it('maps a mute of the bot to a warning-worthy notice', () => {
    expect(mapNotice(notice({ sub_type: 'ban', user_id: SELF_ID }), SELF_ID)).toEqual({
      kind: 'muted',
      groupId: String(GROUP_ID),
      importance: 9,
      wake: true,
      guard: 'warning',
    });
  });

  it('treats user_id 0 (全员禁言) as a mute of the bot', () => {
    expect(mapNotice(notice({ sub_type: 'ban', user_id: 0 }), SELF_ID)).toEqual(
      expect.objectContaining({ kind: 'muted', wake: true, guard: 'warning' }),
    );
  });

  it('ignores a mute of another member', () => {
    expect(mapNotice(notice({ sub_type: 'ban', user_id: 999 }), SELF_ID)).toBeNull();
  });

  it('maps an unmute to a quiet notice that resumes the guard', () => {
    expect(mapNotice(notice({ sub_type: 'lift_ban', user_id: SELF_ID }), SELF_ID)).toEqual({
      kind: 'unmuted',
      groupId: String(GROUP_ID),
      importance: 5,
      wake: false,
      guard: 'resume',
    });
    expect(mapNotice(notice({ sub_type: 'lift_ban', user_id: 0 }), SELF_ID)).toEqual(
      expect.objectContaining({ kind: 'unmuted' }),
    );
    expect(mapNotice(notice({ sub_type: 'lift_ban', user_id: 999 }), SELF_ID)).toBeNull();
  });

  it('maps being kicked to a warning-worthy notice', () => {
    expect(
      mapNotice(
        notice({ notice_type: 'group_decrease', sub_type: 'kick_me', user_id: SELF_ID }),
        SELF_ID,
      ),
    ).toEqual({
      kind: 'kicked',
      groupId: String(GROUP_ID),
      importance: 9,
      wake: true,
      guard: 'warning',
    });
  });

  it('ignores other members leaving or being kicked', () => {
    for (const sub_type of ['kick', 'leave']) {
      expect(
        mapNotice(
          notice({ notice_type: 'group_decrease', sub_type, user_id: 999 }),
          SELF_ID,
        ),
      ).toBeNull();
    }
  });

  it('maps losing admin to a quiet warning notice', () => {
    expect(
      mapNotice(
        notice({ notice_type: 'group_admin', sub_type: 'unset', user_id: SELF_ID }),
        SELF_ID,
      ),
    ).toEqual({
      kind: 'admin-unset',
      groupId: String(GROUP_ID),
      importance: 5,
      wake: false,
      guard: 'warning',
    });
  });

  it('ignores gaining admin and admin changes for other users', () => {
    expect(
      mapNotice(notice({ notice_type: 'group_admin', sub_type: 'set', user_id: SELF_ID }), SELF_ID),
    ).toBeNull();
    expect(
      mapNotice(notice({ notice_type: 'group_admin', sub_type: 'unset', user_id: 999 }), SELF_ID),
    ).toBeNull();
  });

  it('ignores every other notice type', () => {
    for (const notice_type of ['group_increase', 'group_recall', 'friend_add', 'notify']) {
      expect(mapNotice(notice({ notice_type, sub_type: 'x' }), SELF_ID)).toBeNull();
    }
  });

  it('never throws on malformed input', () => {
    const malformed: unknown[] = [
      null,
      'notice',
      42,
      [],
      {},
      { post_type: 'message' },
      { post_type: 'notice' },
      { post_type: 'notice', notice_type: 'group_ban' },
      { post_type: 'notice', notice_type: 'group_ban', self_id: '100', group_id: GROUP_ID },
      { post_type: 'notice', notice_type: 'group_ban', self_id: SELF_ID, group_id: '123' },
      { post_type: 'notice', notice_type: 'group_ban', self_id: SELF_ID, group_id: -1 },
      { post_type: 'notice', notice_type: 'group_ban', self_id: SELF_ID, group_id: 1.5 },
    ];

    for (const event of malformed) {
      expect(() => mapNotice(event, SELF_ID)).not.toThrow();
      expect(mapNotice(event, SELF_ID)).toBeNull();
    }
  });

  it('does not interpolate peer-provided strings into the action', () => {
    const action = mapNotice(
      notice({
        sub_type: 'ban',
        user_id: SELF_ID,
        nickname: 'evil\n\u001b[31m',
        operator_id: 999,
        comment: '<script>',
      }),
      SELF_ID,
    );

    expect(action).toEqual({
      kind: 'muted',
      groupId: String(GROUP_ID),
      importance: 9,
      wake: true,
      guard: 'warning',
    });
    expect(JSON.stringify(action)).not.toContain('evil');
    expect(JSON.stringify(action)).not.toContain('script');
  });

  it('rejects a self_id mismatch so a forged notice cannot retarget the bot', () => {
    expect(
      mapNotice(
        notice({ sub_type: 'ban', user_id: SELF_ID, self_id: SELF_ID + 1 }),
        SELF_ID,
      ),
    ).toBeNull();
  });
});
