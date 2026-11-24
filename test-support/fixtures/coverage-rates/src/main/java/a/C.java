package a;

import java.util.List;
import a.repo.Base;
import lombok.Builder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@CompanyThing
public class C extends Base {

  @GetMapping("/x")
  public String get() {
    return "";
  }

  @CompanyThing
  public void other() {
  }

  @CompanyThing
  public void other2() {
  }

  @CompanyThing
  public void other3() {
  }

  @Builder.Default
  public void built() {
  }

  private UnknownDep dep;

  @CompanyThing
  private List<X> many;

  @Rare
  private X rare;

  @Rare
  private X rare2;
}
