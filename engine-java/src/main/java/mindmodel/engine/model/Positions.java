package mindmodel.engine.model;

import java.io.File;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import spoon.reflect.code.CtInvocation;
import spoon.reflect.cu.CompilationUnit;
import spoon.reflect.cu.SourcePosition;
import spoon.reflect.cu.position.CompoundSourcePosition;
import spoon.reflect.declaration.CtElement;
import spoon.support.reflect.cu.position.SourcePositionImpl;

/**
 * Source positions: project-relative files, and the element's own first token. One instance per dump run, because it
 * owns the checkout's root and the cache of relative names.
 */
public final class Positions {

    /** A position as the dump writes it. */
    public record Pos(String file, int line, int col, int endLine, int endCol) {
    }

    private final Path root;
    /** Project-relative names by file: one dump reads a million-odd elements of the same few thousand files. */
    private final Map<File, String> relative = new HashMap<>();

    /** The checkout the positions are relative to; every path is measured against this canonical root. */
    public Positions(Path root) {
        this.root = root.toAbsolutePath().normalize();
    }

    public Path root() {
        return root;
    }

    /** The element's own first token as a project-relative position, or null when Spoon has none. */
    public Pos of(CtElement element) {
        SourcePosition p = element == null ? null : element.getPosition();
        if (p == null || !p.isValidPosition()) return null;
        return at(p, startOf(p), p.getSourceEnd());
    }

    /**
     * Where Spoon's own start sits: a declaration's name (its annotations and modifiers come before it), else the
     * element's first token. Its line and column are read from this offset.
     */
    private static int startOf(SourcePosition p) {
        return p instanceof CompoundSourcePosition compound ? compound.getNameStart() : p.getSourceStart();
    }

    /**
     * A call's position is its method name's token, not the first token of the call. Spoon starts an invocation at its
     * target, so `a.b().c()` would put both calls at `a`; the name is the identifier before the `(` that opens the
     * call's own argument list. When the text does not show that name, the call's own position is the answer.
     */
    public Pos ofCall(CtInvocation<?> call) {
        Pos whole = of(call);
        SourcePosition p = call.getPosition();
        if (whole == null || call.getTarget() == null || call.getExecutable() == null) return whole;
        String src = SourceText.of(p.getCompilationUnit());
        if (src == null) return whole;
        int[] name = nameSpan(src, p.getSourceStart(), p.getSourceEnd(), call.getExecutable().getSimpleName());
        if (name == null) return whole;
        return at(p, name[0], name[1]);
    }

    /**
     * The span {@code [start, end]} of an element's file, as the dump writes it: Spoon's line for each end, and each
     * column counted in characters of that line, 1-based, a tab one character. Spoon's own column is not used: it is
     * 0-based on the first line and counts a tab as the tabulation size on the last.
     */
    private Pos at(SourcePosition p, int start, int end) {
        File file = p.getFile();
        String rel = file == null ? "" : relative.computeIfAbsent(file,
                f -> root.relativize(f.toPath().toAbsolutePath().normalize()).toString().replace('\\', '/'));
        CompilationUnit unit = p.getCompilationUnit();
        String src = SourceText.of(unit);
        if (src == null) return new Pos(rel, p.getLine(), p.getColumn(), p.getEndLine(), p.getEndColumn());
        return new Pos(rel, lineAt(unit, start), columnAt(src, start), lineAt(unit, end), columnAt(src, end));
    }

    /** Spoon's line of one offset of the unit. */
    private static int lineAt(CompilationUnit unit, int offset) {
        return new SourcePositionImpl(unit, offset, offset, unit.getLineSeparatorPositions()).getLine();
    }

    /** The 1-based column of an offset: the characters between the line's start and the offset, plus one. */
    static int columnAt(String src, int offset) {
        return offset - (src.lastIndexOf('\n', offset - 1) + 1) + 1;
    }

    /**
     * The offsets of a call's method name in its source, or null. A span can carry the parentheses of an enclosing cast
     * (`((Number) m.get(k))`), so the name is not the last top-level `(`: it is the identifier of this name followed by
     * `(` at the shallowest depth, the last one there. Strings, characters, comments and nested brackets are skipped.
     */
    static int[] nameSpan(String src, int start, int end, String name) {
        int last = Math.min(end, src.length() - 1);
        int depth = 0;
        int bestDepth = Integer.MAX_VALUE;
        int best = -1;
        int i = start;
        while (i <= last) {
            int skip = literalOrCommentLength(src, i);
            if (skip > 0) {
                i += skip;
                continue;
            }
            char c = src.charAt(i);
            boolean wordStart = i == start || !Character.isJavaIdentifierPart(src.charAt(i - 1));
            if (Character.isJavaIdentifierStart(c) && wordStart) {
                int stop = i;
                while (stop <= last && Character.isJavaIdentifierPart(src.charAt(stop))) stop++;
                if (src.substring(i, stop).equals(name) && opensArguments(src, stop, last) && depth <= bestDepth) {
                    bestDepth = depth;
                    best = i;
                }
                i = stop;
                continue;
            }
            if (c == '(' || c == '[' || c == '{') depth++;
            if (c == ')' || c == ']' || c == '}') depth--;
            i++;
        }
        return best < 0 ? null : new int[] {best, best + name.length() - 1};
    }

    /** True when the next non-blank character at or after {@code from}, up to {@code last}, is a `(`. */
    private static boolean opensArguments(String src, int from, int last) {
        int k = from;
        while (k <= last && Character.isWhitespace(src.charAt(k))) k++;
        return k <= last && src.charAt(k) == '(';
    }

    /**
     * The length of the string, character or comment literal starting at {@code i}, or 0 when none starts there. A text
     * block runs to its closing triple quote.
     */
    private static int literalOrCommentLength(String src, int i) {
        if (src.startsWith("//", i)) return untilEol(src, i) - i;
        if (src.startsWith("/*", i)) {
            int close = src.indexOf("*/", i + 2);
            return close < 0 ? src.length() - i : close + 2 - i;
        }
        if (src.startsWith("\"\"\"", i)) {
            int close = src.indexOf("\"\"\"", i + 3);
            return close < 0 ? src.length() - i : close + 3 - i;
        }
        char quote = src.charAt(i);
        if (quote != '"' && quote != '\'') return 0;
        int j = i + 1;
        while (j < src.length() && src.charAt(j) != quote && src.charAt(j) != '\n') j += src.charAt(j) == '\\' ? 2 : 1;
        return Math.min(j + 1, src.length()) - i;
    }

    private static int untilEol(String src, int i) {
        int eol = src.indexOf('\n', i);
        return eol < 0 ? src.length() : eol;
    }

    /** The line an element is written on, or null when Spoon has no position for it. */
    public static Integer lineOf(CtElement element) {
        SourcePosition p = element == null ? null : element.getPosition();
        return p == null || !p.isValidPosition() ? null : p.getLine();
    }
}
