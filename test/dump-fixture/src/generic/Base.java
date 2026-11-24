package generic;

public abstract class Base<T> {
    private final Repo<T> repo;

    protected Base(Repo<T> repo) {
        this.repo = repo;
    }

    // `T row` is the type parameter: which type it is comes from the one subclass that names it.
    public void publish(T row) {
        repo.save(row);
        touch(row);
    }

    protected abstract void touch(T row);
}
