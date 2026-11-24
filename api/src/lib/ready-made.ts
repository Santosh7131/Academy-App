import { createHash } from 'node:crypto';
import { arrange, books } from '../ready-made/index.ts';
import type { LibraryBook } from '../ready-made/types.ts';
import { pool, tq, tq1, type Db } from './db.ts';

// Ready-made questions (api/src/ready-made): original chapter-wise MCQs with worked solutions, written for the NCERT 2026-27
// books of Classes 7 to 10 Maths and Classes 9 and 10 Science, ten a chapter, checked by tools/check-library.ts (which proves
// the answers that are numbers worked out by code; a text answer rests on review).
// A tutor adds a book from the question picker of a group whose class and subject it covers (routes/ready-made.ts). Its
// questions are copied in as the tuition's own (source 'library'), so they can be changed or deleted like any other, and
// adding again brings back only the ones the tuition no longer has.

/** The book for a class and a subject, found by the subject's name: Maths (or Mathematics) and Science. */
export function bookFor(classLevel: number, subjectName: string): LibraryBook | null {
  const name = subjectName.trim().toLowerCase();
  const wanted = name === 'mathematics' ? 'maths' : name;
  return books.find((b) => b.classLevel === classLevel && b.subject.toLowerCase() === wanted) ?? null;
}

/** A ready-made question's key in one tuition: each tuition has its own copy, found again when the book is added a second time. */
function readyKey(T: string, b: LibraryBook, chapter: string, text: string): string {
  return 'ready:' + createHash('sha256').update(['ready', T, b.classLevel, b.subject, chapter, text].join('|')).digest('hex').slice(0, 32);
}

const questionCount = (b: LibraryBook) => b.chapters.reduce((n, ch) => n + ch.questions.length, 0);

export type ReadyOffer = { book: string; chapters: number; questions: number; added: number };

/** What there is for a class and subject, and how many of its questions the tuition has now; null when there is no book for them. */
export async function readyOffer(T: string, cls: number, subjectName: string, db: Db = pool): Promise<ReadyOffer | null> {
  const b = bookFor(cls, subjectName);
  if (!b) return null;
  const keys = b.chapters.flatMap((ch) => ch.questions.map((qq) => readyKey(T, b, ch.name, qq.text)));
  const had = await tq1<{ n: number }>(T, 'select count(*)::int as n from questions where tuition_id = @T and library_key = any($1::text[])', [keys], db);
  return { book: b.book, chapters: b.chapters.length, questions: questionCount(b), added: had?.n ?? 0 };
}

/**
 * Copies a book's chapters and questions into the tuition, inside the caller's transaction, and says how many questions it added.
 * A chapter the tuition already has (by its name) is used as it is, and a question it already has (by its key) is left alone, as
 * the tutor may have changed it. Within a chapter the questions keep the book's order: the picker lists the newest first, so each
 * is made a millisecond older than the one before it.
 */
export async function addBook(T: string, b: LibraryBook, subjectId: string, userId: string, cx: Db): Promise<number> {
  await tq(
    T,
    `insert into chapters (tuition_id, class_level, subject_id, name, sort_order)
     select @T, $1, $2, x.name, x.ord - 1 from unnest($3::text[]) with ordinality as x(name, ord)
     on conflict (tuition_id, class_level, subject_id, name) do nothing`,
    [b.classLevel, subjectId, b.chapters.map((ch) => ch.name)],
    cx,
  );
  let ord = 0;
  const rows = b.chapters.flatMap((ch) =>
    ch.questions.map((qq) => {
      const { options, correct } = arrange(qq);
      return { chapter: ch.name, text: qq.text, options, correct, solution: qq.solution, key: readyKey(T, b, ch.name, qq.text), ord: ord++ };
    }),
  );
  const made = await tq(
    T,
    `insert into questions (tuition_id, class_level, chapter_id, subject_id, text, options, correct_option, solution, marks, source,
                            library_key, created_by, created_at, updated_at)
     select @T, $1, ch.id, $2, r.text, array(select jsonb_array_elements_text(r.options)), r.correct, r.solution, 1, 'library',
            r.key, $4, now() - r.ord * interval '1 millisecond', now()
       from jsonb_to_recordset($3::jsonb) as r(chapter text, text text, options jsonb, correct smallint, solution text, key text, ord int)
       join chapters ch on ch.tuition_id = @T and ch.class_level = $1 and ch.subject_id = $2 and ch.name = r.chapter
     on conflict (library_key) do nothing
     returning id`,
    [b.classLevel, subjectId, JSON.stringify(rows), userId],
    cx,
  );
  return made.length;
}
