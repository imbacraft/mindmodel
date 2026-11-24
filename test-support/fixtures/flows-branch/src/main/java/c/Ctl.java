package c;
import org.springframework.web.bind.annotation.PostMapping;
public class Ctl {
  private Repo repo;
  private Charge charge;
  @PostMapping("/orders")
  public void create(Order o, boolean flag) {
    repo.save(o);
    if (flag) {
      charge.send(o);
    }
  }
}
