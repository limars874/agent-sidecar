const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function normalizeCreatedAt(value, source = 'session header timestamp') {
  if (typeof value !== 'string') {
    throw new Error(`${source} must be an RFC 3339 timestamp`);
  }
  const match = RFC3339_RE.exec(value);
  if (!match) throw new Error(`${source} must be an RFC 3339 timestamp`);

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59
  ) {
    throw new Error(`${source} is not a valid date-time`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${source} is not a valid date-time`);
  return date.toISOString();
}

export function getSessionContext(transcript, event) {
  let createdAt = transcript.createdAt ?? null;
  let createdAtError = transcript.createdAtError ?? null;
  if (createdAt !== null) {
    try {
      createdAt = normalizeCreatedAt(createdAt, 'adapter createdAt');
    } catch (err) {
      createdAt = null;
      createdAtError = err.message;
    }
  }
  if (createdAt === null && !createdAtError) createdAtError = 'adapter did not provide a valid createdAt';

  return {
    agent: event.agent,
    sessionId: event.session,
    createdAt,
    sessionMonth: createdAt ? createdAt.slice(0, 7) : null,
    createdAtError,
  };
}
