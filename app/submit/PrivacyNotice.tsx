import { privacyNotice, type NoticeInput } from "@/lib/submissions/privacy-notice";

/** A short, plain-language notice above the form: what is stored, who sees it, how long, and how to ask for deletion. */
export function PrivacyNotice(props: NoticeInput) {
  const notice = privacyNotice(props);
  return (
    <aside aria-labelledby="privacy-title" className="mt-6 rounded-lg border border-line bg-feed p-4">
      <h2 id="privacy-title" className="text-[16px] font-semibold text-ink">
        {notice.heading}
      </h2>
      <dl className="mt-2 flex flex-col gap-2.5 text-[14px] leading-relaxed text-body">
        {notice.items.map((item) => (
          <div key={item.title}>
            <dt className="font-medium text-ink">{item.title}</dt>
            <dd>
              {item.title === "Asking us to delete it" && notice.contact ? (
                <>
                  {item.text.split(notice.contact)[0]}
                  <a href={`mailto:${notice.contact}`} className="font-medium text-deep-sage underline">
                    {notice.contact}
                  </a>
                  {item.text.split(notice.contact).slice(1).join(notice.contact)}
                </>
              ) : (
                item.text
              )}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
