// Google Calendar API client

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';
const TIMEZONE = 'Asia/Tokyo';

export interface GoogleCalendarConfig {
  /** Events are created on and deleted from this calendar. */
  calendarId: string;
  accessToken: string;
  /**
   * Calendars consulted when checking whether a slot is free. Defaults to
   * [calendarId]. Once calendars are split by purpose (personal / lessons /
   * consultations), the write target alone no longer covers every commitment,
   * so conflicts must be gathered across all of them.
   */
  freeBusyCalendarIds?: string[];
}

export interface BusyInterval {
  start: string;
  end: string;
}

export interface CreateEventInput {
  summary: string;
  start: string;   // ISO datetime string
  end: string;     // ISO datetime string
  description?: string;
}

export class GoogleCalendarClient {
  constructor(private config: GoogleCalendarConfig) {}

  /**
   * Get busy time intervals from Google Calendar FreeBusy API.
   * Returns an array of { start, end } intervals when the calendar is busy.
   */
  /** Calendars to consult for conflicts — the configured list, or the write target. */
  private get freeBusyCalendarIds(): string[] {
    const ids = this.config.freeBusyCalendarIds?.filter(Boolean) ?? [];
    return ids.length > 0 ? ids : [this.config.calendarId];
  }

  async getFreeBusy(timeMin: string, timeMax: string): Promise<BusyInterval[]> {
    const url = `${GCAL_BASE}/freeBusy`;
    const calendarIds = this.freeBusyCalendarIds;
    const body = {
      timeMin,
      timeMax,
      items: calendarIds.map((id) => ({ id })),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google FreeBusy API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      calendars?: Record<
        string,
        { busy?: { start: string; end: string }[]; errors?: { domain?: string; reason?: string }[] }
      >;
    };

    // FreeBusy reports per-calendar failures inline instead of failing the whole
    // request, so an unshared calendar comes back as "no busy times" — which
    // reads as "totally free" and hands out a slot we are not actually free for.
    // Never let that pass silently; the usual cause is a calendar that was not
    // shared with the service account.
    const merged: BusyInterval[] = [];
    for (const id of calendarIds) {
      const entry = data.calendars?.[id];
      if (!entry) {
        console.error(`GCal freeBusy: no data returned for calendar ${id} — is it shared with this account?`);
        continue;
      }
      if (entry.errors?.length) {
        console.error(
          `GCal freeBusy: calendar ${id} returned errors (${entry.errors
            .map((e) => e.reason ?? e.domain ?? 'unknown')
            .join(', ')}) — its events are NOT blocking slots. Check sharing.`,
        );
        continue;
      }
      merged.push(...(entry.busy ?? []));
    }

    return merged;
  }

  /**
   * List the calendars this account can see, for the admin picker.
   * Only calendars shared with the service account appear here.
   */
  async listCalendars(): Promise<{ id: string; summary: string; accessRole: string }[]> {
    const url = `${GCAL_BASE}/users/me/calendarList?minAccessRole=reader&maxResults=250`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google calendarList error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      items?: { id?: string; summary?: string; accessRole?: string }[];
    };

    return (data.items ?? [])
      .filter((it): it is { id: string; summary?: string; accessRole?: string } => Boolean(it.id))
      .map((it) => ({ id: it.id, summary: it.summary ?? it.id, accessRole: it.accessRole ?? 'reader' }));
  }

  /**
   * Create an event on Google Calendar.
   * Returns the created event's ID.
   */
  async createEvent(event: CreateEventInput): Promise<{ eventId: string }> {
    const url = `${GCAL_BASE}/calendars/${encodeURIComponent(this.config.calendarId)}/events`;

    const body = {
      summary: event.summary,
      description: event.description,
      start: { dateTime: event.start, timeZone: TIMEZONE },
      end: { dateTime: event.end, timeZone: TIMEZONE },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google Calendar createEvent error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      throw new Error('Google Calendar createEvent: response missing event id');
    }

    return { eventId: data.id };
  }

  /**
   * Delete an event from Google Calendar.
   */
  async deleteEvent(eventId: string): Promise<void> {
    const url = `${GCAL_BASE}/calendars/${encodeURIComponent(this.config.calendarId)}/events/${encodeURIComponent(eventId)}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
      },
    });

    // 204 = success, 410 = already deleted — both are acceptable
    if (!res.ok && res.status !== 410) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google Calendar deleteEvent error ${res.status}: ${text}`);
    }
  }
}
