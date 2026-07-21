import Header from "@/components/Header";

export default function AdminLessonsLoading() {
  return (
    <>
      <Header screenTitle="Lesson Requests" />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-2xl md:mx-auto px-4 pt-4 pb-8 space-y-3">
          <div className="h-8 w-40 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse" />
          {[1, 2, 3].map(i => (
            <div key={i} className="ct-card px-4 py-4 space-y-2 animate-pulse">
              <div className="h-4 w-28 bg-gray-200 dark:bg-gray-700 rounded" />
              <div className="h-3 w-44 bg-gray-100 dark:bg-gray-800 rounded" />
              <div className="h-3 w-32 bg-gray-100 dark:bg-gray-800 rounded" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
