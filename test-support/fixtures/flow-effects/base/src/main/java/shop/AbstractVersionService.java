package shop;

public abstract class AbstractVersionService<T> {
    private final GenericRepo<T> repo;

    protected AbstractVersionService(GenericRepo<T> repo) {
        this.repo = repo;
    }

    public void publish(Long id) {
        T row = repo.findById(id).orElseThrow();
        row.setStatus(VoucherStatus.PUBLISHED);
        repo.save(row);
    }
}
