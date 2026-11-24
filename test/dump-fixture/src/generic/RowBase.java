package generic;

public class RowBase extends Base<Row> {
    public RowBase(Repo<Row> repo) {
        super(repo);
    }

    @Override
    public void publish(Row row) {
        super.publish(row);
    }

    @Override
    protected void touch(Row row) {
        row.revise();
    }
}
