package generic;

public class FirstImpl implements Port {
    @Override
    public void go(Row row) {
        row.revise();
    }
}
