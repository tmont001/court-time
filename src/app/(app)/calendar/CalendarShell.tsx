"use client";

// Time gutter: 8 AM – 7 PM in 30-min slots
const START_HOUR = 8;
const END_HOUR = 19;

function buildTimeSlots(): string[] {
  const slots: string[] = [];
  for (let h = START_HOUR; h < END_HOUR; h++) {
    const ampm = h < 12 ? "AM" : "PM";
    const display = h <= 12 ? h : h - 12;
    slots.push(`${display}:00 ${ampm}`);
    slots.push(`${display}:30 ${ampm}`);
  }
  return slots;
}

const TIME_SLOTS = buildTimeSlots();

// Date strip: today ± 6 days (13 pills)
function buildDateStrip(): { label: string; sublabel: string; isToday: boolean }[] {
  const days: { label: string; sublabel: string; isToday: boolean }[] = [];
  const today = new Date();
  for (let offset = -3; offset <= 9; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    days.push({
      label: dayNames[d.getDay()],
      sublabel: String(d.getDate()),
      isToday: offset === 0,
    });
  }
  return days;
}

const DATE_STRIP = buildDateStrip();

interface Court {
  id: string;
  name: string;
  display_order: number;
}

interface Props {
  courts: Court[];
}

const GUTTER_W = 56; // px width of time gutter
const COL_W = 80;    // px width of each court column
const ROW_H = 40;    // px height of each 30-min slot

export default function CalendarShell({ courts }: Props) {
  const totalCols = courts.length;
  const gridWidth = GUTTER_W + totalCols * COL_W;

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem-4rem)] overflow-hidden">
      {/* Date strip */}
      <div className="flex overflow-x-auto gap-2 px-4 py-3 border-b border-gray-100 shrink-0">
        {DATE_STRIP.map((d, i) => (
          <div
            key={i}
            className={`flex flex-col items-center justify-center rounded-full shrink-0 w-11 h-11 text-xs ${
              d.isToday
                ? "bg-gray-900 text-white font-semibold"
                : "text-gray-500"
            }`}
          >
            <span>{d.label}</span>
            <span>{d.sublabel}</span>
          </div>
        ))}
      </div>

      {/* View toggle */}
      <div className="flex gap-1 px-4 py-2 border-b border-gray-100 shrink-0">
        {["Day", "Week", "My Schedule"].map((v) => (
          <button
            key={v}
            disabled
            className={`px-3 py-1 rounded-full text-xs font-medium ${
              v === "Day"
                ? "bg-gray-900 text-white"
                : "bg-gray-100 text-gray-500"
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      {/* Court chips */}
      <div className="flex gap-2 px-4 py-2 border-b border-gray-100 overflow-x-auto shrink-0">
        <button
          disabled
          className="px-3 py-1 rounded-full text-xs font-medium bg-gray-900 text-white shrink-0"
        >
          All
        </button>
        {courts.map((court) => (
          <button
            key={court.id}
            disabled
            className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500 shrink-0"
          >
            {court.name}
          </button>
        ))}
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-auto">
        <div style={{ width: gridWidth, minWidth: "100%" }}>
          {/* Court header row */}
          <div
            className="flex border-b border-gray-200 bg-white sticky top-0 z-10"
            style={{ width: gridWidth }}
          >
            {/* Gutter space */}
            <div style={{ width: GUTTER_W, minWidth: GUTTER_W }} />
            {courts.map((court) => (
              <div
                key={court.id}
                className="border-l border-gray-200 text-xs font-medium text-gray-600 text-center py-2"
                style={{ width: COL_W, minWidth: COL_W }}
              >
                {court.name}
              </div>
            ))}
          </div>

          {/* Time rows */}
          {TIME_SLOTS.map((slot, rowIdx) => (
            <div
              key={rowIdx}
              className="flex"
              style={{ height: ROW_H, width: gridWidth }}
            >
              {/* Time label */}
              <div
                className="flex items-start justify-end pr-2 pt-1 text-xs text-gray-400 shrink-0 border-r border-gray-200"
                style={{ width: GUTTER_W, minWidth: GUTTER_W }}
              >
                {slot.endsWith(":00 AM") || slot.endsWith(":00 PM")
                  ? slot
                  : ""}
              </div>
              {/* Court columns */}
              {courts.map((court) => (
                <div
                  key={court.id}
                  className="border-l border-gray-100 border-b border-b-gray-100"
                  style={{ width: COL_W, minWidth: COL_W, height: ROW_H }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
