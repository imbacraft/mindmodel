package mindmodel.engine;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import spoon.Launcher;
import spoon.compiler.Environment;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.declaration.CtType;

import mindmodel.engine.dump.Names;

/**
 * A Spoon model over an explicit file list: no classpath, no comments, no compilation. Files are resolved through
 * real paths so that the paths Spoon reports match the project-relative paths the Node side uses (macOS /tmp is a
 * symlink).
 */
public final class SourceModel {

    private final Path root;
    private final List<String> files;
    private final Launcher launcher;

    private SourceModel(Path root, List<String> files, Launcher launcher) {
        this.root = root;
        this.files = files;
        this.launcher = launcher;
    }

    /** Normalises the file list to project-relative POSIX paths and drops anything outside the root. */
    public static List<String> relativeFiles(Path root, List<String> listed) {
        Set<String> out = new LinkedHashSet<>();
        Path realRoot = realPath(root);
        for (String raw : listed) {
            if (raw == null) continue;
            String text = raw.trim();
            if (text.isEmpty() || !text.endsWith(".java")) continue;
            Path p = realPath(realRoot.resolve(text));
            if (!p.startsWith(realRoot) || !Files.isRegularFile(p)) continue;
            out.add(realRoot.relativize(p).toString().replace('\\', '/'));
        }
        return new ArrayList<>(out);
    }

    public static SourceModel build(Path root, List<String> relFiles) {
        return build(root, relFiles, compliance());
    }

    /** The project's Java level: an explicit MINDMODEL_COMPLIANCE, else 17. Hertzbeat needs 21 for switch patterns. */
    public static int compliance() {
        String env = System.getenv("MINDMODEL_COMPLIANCE");
        if (env != null && env.matches("\\d{2}")) return Integer.parseInt(env);
        return 17;
    }

    public static SourceModel build(Path root, List<String> relFiles, int compliance) {
        Path realRoot = realPath(root);
        Launcher launcher = new Launcher();
        Environment env = launcher.getEnvironment();
        env.setNoClasspath(true);
        env.setCommentEnabled(false);
        env.setShouldCompile(false);
        env.setIgnoreDuplicateDeclarations(true);
        env.setComplianceLevel(compliance);
        env.setAutoImports(false);
        env.setCopyResources(false);
        env.setLevel("OFF");
        for (String rel : relFiles) launcher.addInputResource(realRoot.resolve(rel).toString());
        launcher.buildModel();
        return new SourceModel(realRoot, List.copyOf(relFiles), launcher);
    }

    public Path root() {
        return root;
    }

    public List<String> files() {
        return files;
    }

    public List<CtType<?>> allTypes() {
        return new ArrayList<>(launcher.getModel().getAllTypes());
    }

    /** Every invocation anywhere in the model, anonymous and local class bodies included. */
    public List<CtInvocation<?>> allInvocations() {
        return new ArrayList<>(launcher.getModel().getElements(new spoon.reflect.visitor.filter.TypeFilter<>(
                CtInvocation.class)));
    }

    /**
     * Each input file's own package, from its compilation unit: {@code ""} for the default package. A file that declares
     * no type is still a file with a package, and this is where that is read.
     */
    public Map<String, String> packages() {
        Map<String, String> out = new java.util.LinkedHashMap<>();
        for (var unit : launcher.getFactory().CompilationUnit().getMap().entrySet()) {
            String rel = relative(Path.of(unit.getKey()));
            if (rel == null) continue;
            var declared = unit.getValue().getPackageDeclaration();
            out.put(rel, declared == null || declared.getReference() == null ? ""
                    : declared.getReference().getQualifiedName());
        }
        return out;
    }

    /**
     * Files whose declared types Spoon could not read at all: a cross-package static import of one of a type's members
     * makes the reference builder lay a bare shell — a name, no position, no members — before the type's own file is
     * read, and the shell keeps the name. The file is parsed; its type is not. Sorted, so a rebuild reads them in one
     * order.
     */
    public List<String> unreadFiles() {
        List<String> out = new ArrayList<>();
        for (var unit : launcher.getFactory().CompilationUnit().getMap().entrySet()) {
            String rel = relative(Path.of(unit.getKey()));
            if (rel == null || unit.getValue().getDeclaredTypes().isEmpty()) continue;
            boolean read = false;
            for (CtType<?> t : unit.getValue().getDeclaredTypes())
                if (t.getPosition() != null && t.getPosition().isValidPosition()) {
                    read = true;
                    break;
                }
            if (!read) out.add(rel);
        }
        out.sort(null);
        return out;
    }

    /**
     * The qualified names of the types Spoon built as bare shells — a name, no position, no members. They are what a
     * static import of their members named.
     */
    public java.util.Set<String> unreadNames() {
        java.util.Set<String> out = new java.util.LinkedHashSet<>();
        for (var unit : launcher.getFactory().CompilationUnit().getMap().entrySet()) {
            String rel = relative(Path.of(unit.getKey()));
            if (rel == null) continue;
            for (CtType<?> t : unit.getValue().getDeclaredTypes())
                if (t.getPosition() == null || !t.getPosition().isValidPosition()) out.add(Names.qualified(t));
        }
        return out;
    }

    /**
     * The files whose header statically imports a member of one of `fqns`. They are the ones that lay the shell, so a
     * model built without them reads the type itself. The header is the file's own text: Spoon drops a static import it
     * cannot resolve, which is exactly the import that lays the shell.
     */
    public List<String> filesImporting(java.util.Set<String> fqns) {
        List<String> out = new ArrayList<>();
        for (String rel : files)
            for (String owner : mindmodel.engine.dump.Files.staticOwners(root, rel))
                if (fqns.contains(owner)) {
                    out.add(rel);
                    break;
                }
        return out;
    }

    /** Project-relative name of a file under this root, or null when it is outside it or not one of the inputs. */
    private String relative(Path file) {
        Path p = realPath(file);
        if (!p.startsWith(root)) return null;
        String rel = root.relativize(p).toString().replace('\\', '/');
        return files.contains(rel) ? rel : null;
    }

    /** Every type declared in one of the listed files, anonymous and local types included. */
    public List<CtType<?>> typesInProject() {
        List<CtType<?>> out = new ArrayList<>();
        for (CtType<?> t : allTypes()) if (fileOf(t) != null) out.add(t);
        return out;
    }

    /** Project-relative path of the file a type is declared in, or null when Spoon has no usable position. */
    public String fileOf(CtType<?> t) {
        if (t == null || t.getPosition() == null || !t.getPosition().isValidPosition()) return null;
        java.io.File f = t.getPosition().getFile();
        if (f == null) return null;
        Path p = realPath(f.toPath());
        if (!p.startsWith(root)) return null;
        String rel = root.relativize(p).toString().replace('\\', '/');
        return files.contains(rel) ? rel : null;
    }

    /** Project-relative path of the file an element is declared in; null for library and shadow elements. */
    public String fileOf(spoon.reflect.declaration.CtElement e) {
        if (e == null || e.getPosition() == null || !e.getPosition().isValidPosition()) return null;
        java.io.File f = e.getPosition().getFile();
        if (f == null) return null;
        Path p = realPath(f.toPath());
        if (!p.startsWith(root)) return null;
        String rel = root.relativize(p).toString().replace('\\', '/');
        return files.contains(rel) ? rel : null;
    }

    /** Parse problems JDT reported, so the dump can name a file it could not read instead of dropping it silently. */
    public List<org.eclipse.jdt.core.compiler.CategorizedProblem> problems() {
        List<org.eclipse.jdt.core.compiler.CategorizedProblem> out = new ArrayList<>();
        if (!(launcher.getModelBuilder()
                instanceof spoon.support.compiler.jdt.JDTBasedSpoonCompiler compiler)) return out;
        for (org.eclipse.jdt.core.compiler.CategorizedProblem p : compiler.getProblems())
            if (p.isError()) out.add(p);
        return out;
    }

    public static Path realPath(Path p) {
        try {
            return p.toRealPath();
        } catch (IOException e) {
            return p.toAbsolutePath().normalize();
        }
    }
}
